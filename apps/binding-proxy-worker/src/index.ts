/**
 * Binding Proxy Worker
 *
 * Proxies AI and Vectorize bindings for jack cloud user workers.
 * Provides metering, quota enforcement, and usage tracking.
 *
 * Architecture:
 * 1. User worker has a service binding to this proxy
 * 2. Jack's client wrappers send fetch requests with context headers
 * 3. Proxy checks quota, forwards to real AI/Vectorize, meters usage
 *
 * Routes:
 * - POST /ai/run - AI inference proxy
 * - POST /vectorize - Vectorize operations proxy
 * - GET /health - Health check
 *
 * @see /docs/internal/specs/binding-proxy-worker.md
 */

import type { Env } from "./types";
import { AIHandler } from "./handlers/ai";
import { VectorizeHandler } from "./handlers/vectorize";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "binding-proxy",
				timestamp: new Date().toISOString(),
			});
		}

		// AI proxy endpoint
		if (url.pathname === "/ai/run" && request.method === "POST") {
			const handler = new AIHandler(env);
			return handler.handleRequest(request, ctx);
		}

		// Vectorize proxy endpoint
		if (url.pathname === "/vectorize" && request.method === "POST") {
			const handler = new VectorizeHandler(env);
			return handler.handleRequest(request, ctx);
		}

		// Unknown route
		return Response.json(
			{
				error: "Unknown endpoint",
				routes: {
					"/ai/run": "POST - AI inference proxy",
					"/vectorize": "POST - Vectorize operations proxy",
					"/health": "GET - Health check",
				},
			},
			{ status: 404 },
		);
	},
};
