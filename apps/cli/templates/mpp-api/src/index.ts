import { Hono } from "hono";
import { cors } from "hono/cors";
import { Mppx, tempo } from "mppx/server";
import { createJackAI } from "./jack-ai";

interface Env {
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	TEMPO_RECIPIENT: string;
	MPP_SECRET_KEY: string;
}

const ALLOWED_MODELS = [
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-3.2-3b-instruct",
	"@cf/meta/llama-3.2-1b-instruct",
	"@cf/mistral/mistral-7b-instruct-v0.2",
] as const;

const DEFAULT_MODEL = ALLOWED_MODELS[0];

function getAI(env: Env) {
	if (env.__AI_PROXY) {
		return createJackAI(env as { __AI_PROXY: Fetcher });
	}
	if (env.AI) return env.AI;
	throw new Error("No AI binding available. Deploy with `jack ship`.");
}

function getMppx(env: Env) {
	return Mppx.create({
		secretKey: env.MPP_SECRET_KEY,
		methods: [
			tempo({
				currency: "0x20c000000000000000000000b9537d11c60e8b50", // USDC on Tempo
				recipient: env.TEMPO_RECIPIENT,
			}),
		],
	});
}

const app = new Hono<{ Bindings: Env }>();

app.use(
	"/*",
	cors({
		origin: "*",
		allowHeaders: ["Content-Type", "Authorization"],
		exposeHeaders: ["WWW-Authenticate", "Payment-Receipt"],
	}),
);

// Free: service info and pricing
app.get("/", (c) => {
	return c.json({
		name: "jack-template",
		description: "AI proxy with machine payments via MPP",
		endpoints: {
			"POST /v1/chat/completions":
				"Chat completion — $0.01 per request (paid via MPP)",
			"GET /health": "Health check (free)",
		},
		models: ALLOWED_MODELS,
		payment: {
			protocol: "MPP (HTTP 402)",
			method: "Tempo (pathUSD stablecoin)",
			price_per_request: "$0.01",
			docs: "https://mpp.dev",
		},
	});
});

app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: Date.now() });
});

// Paid: AI chat completion (OpenAI-compatible shape)
app.post("/v1/chat/completions", async (c) => {
	// Clone raw request before consuming body — mppx needs headers + body intact
	const rawRequest = c.req.raw.clone();

	// Validate request before payment
	let body: { messages: Array<{ role: string; content: string }>; model?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	if (!body.messages?.length) {
		return c.json({ error: "messages array required" }, 400);
	}

	const model = body.model || DEFAULT_MODEL;
	if (!ALLOWED_MODELS.includes(model as (typeof ALLOWED_MODELS)[number])) {
		return c.json(
			{ error: `Model not supported. Allowed: ${ALLOWED_MODELS.join(", ")}` },
			400,
		);
	}

	// Payment gate — only charged after validation passes
	const mppx = getMppx(c.env);
	const payment = await mppx.charge({ amount: "0.01" })(rawRequest);

	if (payment.status === 402) {
		return payment.challenge;
	}

	const ai = getAI(c.env);

	try {
		const result = (await ai.run(model, {
			messages: body.messages,
		})) as { response?: string };

		return payment.withReceipt(
			c.json({
				id: `chatcmpl-${crypto.randomUUID().slice(0, 8)}`,
				object: "chat.completion",
				model,
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: result.response ?? "",
						},
						finish_reason: "stop",
					},
				],
			}),
		);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : "AI inference failed";
		return c.json({ error: message }, 502);
	}
});

export default app;
