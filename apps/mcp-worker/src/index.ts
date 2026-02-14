import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AuthHandler } from "./auth-handler.ts";
import { createMcpServer } from "./server.ts";
import type { Bindings, Props } from "./types.ts";

type HandlerWithFetch = ExportedHandler & Pick<Required<ExportedHandler>, "fetch">;

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
		const token = props.accessToken;
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

export default new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: mcpHandler as HandlerWithFetch,
	defaultHandler: AuthHandler as unknown as HandlerWithFetch,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
	async resolveExternalToken({ token }) {
		if (token.startsWith("jkt_")) {
			return {
				props: { accessToken: token, userId: "", email: "" },
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
