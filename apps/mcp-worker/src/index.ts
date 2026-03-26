export { ComputeSession } from "./compute-session.ts";

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthHandler } from "./auth-handler.ts";
import { createMcpServer } from "./server.ts";
import type { Bindings, Props } from "./types.ts";

type HandlerWithFetch = ExportedHandler & Pick<Required<ExportedHandler>, "fetch">;

function isTokenExpired(token: string): boolean {
	try {
		const payload = JSON.parse(atob(token.split(".")[1]));
		return payload.exp ? payload.exp * 1000 < Date.now() - 30_000 : false;
	} catch {
		return false;
	}
}

async function refreshWorkosToken(
	refreshToken: string,
	env: Bindings,
): Promise<string | null> {
	const res = await fetch("https://api.workos.com/user_management/authenticate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: env.WORKOS_CLIENT_ID,
			client_secret: env.WORKOS_API_KEY,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		}),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { access_token: string };
	return data.access_token;
}

const mcpHandler = {
	async fetch(
		request: Request,
		env: Bindings,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json(
				{
					jsonrpc: "2.0",
					error: { code: -32000, message: "Only POST is supported." },
					id: null,
				},
				{ status: 405 },
			);
		}

		const props = (ctx as ExecutionContext & { props: Props }).props;
		let token = props.accessToken;

		// Refresh expired WorkOS tokens (OAuth path only)
		if (props.refreshToken && isTokenExpired(token)) {
			const fresh = await refreshWorkosToken(props.refreshToken, env);
			if (fresh) {
				token = fresh;
			}
		}

		const start = Date.now();
		const server = createMcpServer(token, env);

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});

		await server.connect(transport);

		try {
			const response = await transport.handleRequest(request);
			await transport.close();
			await server.close();

			console.log(
				JSON.stringify({
					event: "mcp_request",
					duration_ms: Date.now() - start,
					status: response.status,
					auth: props.userId ? "oauth" : "token",
				}),
			);

			return response;
		} catch (error) {
			await transport.close();
			await server.close();

			const message = error instanceof Error ? error.message : String(error);
			console.log(
				JSON.stringify({
					event: "mcp_request",
					duration_ms: Date.now() - start,
					status: 500,
					error: message,
				}),
			);

			return Response.json(
				{
					jsonrpc: "2.0",
					error: { code: -32603, message: `Internal error: ${message}` },
					id: null,
				},
				{ status: 500 },
			);
		}
	},
};

// Public MCP endpoint for MPP-only access (no OAuth required)
// tempo request / mppx clients hit this without any auth token
const publicMcpHandler: HandlerWithFetch = {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32000, message: "Only POST is supported." }, id: null },
				{ status: 405 },
			);
		}

		// Set empty props — execute_code will handle payment via MPP
		(ctx as ExecutionContext & { props: Props }).props = {
			accessToken: "",
			refreshToken: "",
			userId: "",
			email: "",
		};

		// Inject Accept header if missing — MPP/tempo clients don't send it
		// but the MCP SDK transport requires it
		const accept = request.headers.get("Accept") || "";
		if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
			const headers = new Headers(request.headers);
			headers.set("Accept", "application/json, text/event-stream");
			request = new Request(request, { headers });
		}

		return mcpHandler.fetch(request, env, ctx);
	},
};

const oauthProvider = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: mcpHandler as HandlerWithFetch,
	defaultHandler: AuthHandler as unknown as HandlerWithFetch,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	async resolveExternalToken({ token }) {
		// Allow MPP-only requests (no real auth -- execute_code handles payment itself)
		if (token === "mpp") {
			return {
				props: { accessToken: "", refreshToken: "", userId: "", email: "" },
			};
		}

		if (token.startsWith("jkt_")) {
			return {
				props: { accessToken: token, refreshToken: "", userId: "", email: "" },
			};
		}

		const parts = token.split(".");
		if (parts.length === 3) {
			try {
				const payload = JSON.parse(atob(parts[1]));
				if (payload.sub || payload.email) {
					return {
						props: {
							accessToken: token,
							refreshToken: "",
							userId: payload.sub || "",
							email: payload.email || "",
						},
					};
				}
			} catch {
				// Not a valid JWT
			}
		}

		return null;
	},
});

// Direct HTTP /execute endpoint — standard HTTP 402 + WWW-Authenticate
// Works with tempo request, mppx, curl, any HTTP client
async function handleHttpExecute(request: Request, env: Bindings): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "POST only" }, { status: 405 });
	}

	const { Mppx, tempo } = await import("mppx/server");

	const mppx = Mppx.create({
		secretKey: env.MPP_SECRET_KEY,
		methods: [
			tempo({
				currency: "0x20c000000000000000000000b9537d11c60e8b50" as `0x${string}`,
				recipient: env.TEMPO_RECIPIENT as `0x${string}`,
			}),
		],
	});

	let body: { code: string; input?: unknown };
	try {
		body = await request.clone().json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}

	if (!body.code || typeof body.code !== "string") {
		return Response.json({ error: "code field required" }, { status: 400 });
	}

	if (new TextEncoder().encode(body.code).byteLength > 500 * 1024) {
		return Response.json({ error: "Code exceeds 500KB limit" }, { status: 413 });
	}

	const payment = await mppx.charge({ amount: "0.01" })(request);

	if (payment.status === 402) {
		return payment.challenge;
	}

	const wrappedCode = `
import { WorkerEntrypoint } from "cloudflare:workers";
const __mod = await import("./user-code.js");
const __run = __mod.run || __mod.default?.run || __mod.default;
export default class extends WorkerEntrypoint {
  async run(input) {
    if (typeof __run !== "function") throw new Error("Code must export a run(input) function");
    return __run(input);
  }
}`;

	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code));
	const workerId = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

	const startTime = Date.now();
	try {
		const worker = await env.LOADER.get(workerId, async () => ({
			mainModule: "agent.js",
			modules: { "agent.js": wrappedCode, "user-code.js": body.code },
			compatibilityDate: "2026-03-01",
			compatibilityFlags: ["nodejs_compat"],
			env: {},
			globalOutbound: null,
		}));

		const result = await worker.getEntrypoint().run(body.input ?? {});
		return payment.withReceipt(Response.json({ result, duration_ms: Date.now() - startTime }));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Execution failed";
		return payment.withReceipt(Response.json({ error: message }, { status: 502 }));
	}
}

// Route: /execute for HTTP clients, /mcp/public for MCP clients, everything else through OAuth
export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/execute") {
			return handleHttpExecute(request, env);
		}
		if (url.pathname === "/mcp/public") {
			return publicMcpHandler.fetch(request, env, ctx);
		}
		return oauthProvider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Bindings>;
