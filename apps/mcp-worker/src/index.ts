import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMcpServer } from "./server.ts";
import type { Bindings } from "./types.ts";

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization", "Accept"],
	}),
);

// Health check (no auth)
app.get("/", (c) => {
	return c.json({ service: "jack-mcp", status: "ok", version: "1.0.0" });
});

// MCP endpoint — stateless, one server+transport per request
// Uses WebStandardStreamableHTTPServerTransport which works with Web Standard Request/Response
// (not Node.js IncomingMessage/ServerResponse), compatible with Cloudflare Workers.
app.all("/mcp", async (c) => {
	// Auth check (only for POST — GET and DELETE return 405 via the transport)
	if (c.req.method === "POST") {
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{
					jsonrpc: "2.0",
					error: { code: -32001, message: "Missing or invalid Authorization header" },
					id: null,
				},
				401,
			);
		}

		const token = authHeader.slice(7);
		const start = Date.now();

		// Create a fresh server + transport per request (stateless)
		const server = createMcpServer(token, c.env);

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // Stateless mode — no session tracking
			enableJsonResponse: true, // Return JSON instead of SSE for simple request/response
		});

		await server.connect(transport);

		try {
			// handleRequest takes a Web Standard Request and returns a Web Standard Response
			const response = await transport.handleRequest(c.req.raw);

			// Close transport after handling
			await transport.close();
			await server.close();

			console.log(
				JSON.stringify({
					event: "mcp_request",
					duration_ms: Date.now() - start,
					status: response.status,
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
			return c.json(
				{
					jsonrpc: "2.0",
					error: { code: -32603, message: `Internal error: ${message}` },
					id: null,
				},
				500,
			);
		}
	}

	// GET and DELETE: stateless servers don't support SSE resumption or session termination
	return c.json(
		{
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "This server operates in stateless mode. Only POST is supported.",
			},
			id: null,
		},
		405,
	);
});

export default app;
