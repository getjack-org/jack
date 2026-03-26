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

// Route: /mcp/public bypasses OAuth, everything else goes through OAuthProvider
export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/mcp/public") {
			return publicMcpHandler.fetch(request, env, ctx);
		}
		return oauthProvider.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Bindings>;
