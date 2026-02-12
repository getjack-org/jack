import { Hono } from "hono";
import { streamText, convertToCoreMessages, type Message } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createJackAI } from "./jack-ai";

interface Env {
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	__JACK_PROJECT_ID?: string;
	__JACK_ORG_ID?: string;
	ASSETS: Fetcher;
	DB: D1Database;
}

function getAI(env: Env) {
	if (env.__AI_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
		return createJackAI(
			env as Required<
				Pick<Env, "__AI_PROXY" | "__JACK_PROJECT_ID" | "__JACK_ORG_ID">
			>,
		);
	}
	if (env.AI) return env.AI;
	throw new Error("No AI binding available");
}

const SYSTEM_PROMPT = `You are a helpful AI assistant. Be concise, friendly, and helpful. Keep responses short unless detail is needed.`;

// Rate limiting
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);
	if (!entry || now >= entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return true;
	}
	if (entry.count >= RATE_LIMIT) return false;
	entry.count++;
	return true;
}

const app = new Hono<{ Bindings: Env }>();

// Create new chat
app.post("/api/chat/new", async (c) => {
	const id = crypto.randomUUID();
	await c.env.DB.prepare("INSERT INTO chats (id) VALUES (?)").bind(id).run();
	return c.json({ id });
});

// Load chat history
app.get("/api/chat/:id", async (c) => {
	const chatId = c.req.param("id");
	const { results } = await c.env.DB.prepare(
		"SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
	)
		.bind(chatId)
		.all();
	return c.json({ messages: results || [] });
});

// Chat endpoint with streaming
app.post("/api/chat", async (c) => {
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	if (!checkRateLimit(ip)) {
		return c.json({ error: "Too many requests. Please wait a moment." }, 429);
	}

	const { messages, chatId } = await c.req.json<{
		messages: Message[];
		chatId?: string;
	}>();
	if (!messages || !Array.isArray(messages)) {
		return c.json({ error: "Invalid request." }, 400);
	}

	// Save user message to DB if we have a chatId
	const lastUserMsg = messages.findLast((m: Message) => m.role === "user");
	if (chatId && lastUserMsg) {
		await c.env.DB.prepare(
			"INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
		)
			.bind(
				crypto.randomUUID(),
				chatId,
				"user",
				typeof lastUserMsg.content === "string"
					? lastUserMsg.content
					: JSON.stringify(lastUserMsg.content),
			)
			.run();
	}

	const ai = getAI(c.env);
	const provider = createWorkersAI({ binding: ai as Ai });

	const result = streamText({
		model: provider("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
		system: SYSTEM_PROMPT,
		messages: convertToCoreMessages(messages),
		onFinish: async ({ text }) => {
			// Save assistant response to DB
			if (chatId && text) {
				await c.env.DB.prepare(
					"INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
				)
					.bind(crypto.randomUUID(), chatId, "assistant", text)
					.run();
			}
		},
	});

	return result.toDataStreamResponse();
});

// Serve static assets for non-API routes
app.get("*", async (c) => {
	return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
