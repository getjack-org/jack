/**
 * Binding Proxy Worker
 *
 * Proxies AI and Vectorize bindings for jack cloud user workers.
 * Provides metering, quota enforcement, and usage tracking.
 *
 * Architecture:
 * 1. User worker has a service binding to this proxy via ProxyEntrypoint
 * 2. Service binding includes ctx.props with {projectId, orgId} set at deploy time
 * 3. Proxy reads unforgeable identity from ctx.props, checks quota, forwards to real AI/Vectorize
 *
 * Routes:
 * - POST /ai/run - AI inference proxy
 * - POST /vectorize - Vectorize operations proxy
 * - GET /health - Health check
 *
 * @see /docs/internal/specs/binding-proxy-worker.md
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { AIHandler } from "./handlers/ai";
import { VectorizeHandler } from "./handlers/vectorize";
import type { Env, ProxyIdentity, ProxyProps } from "./types";

/**
 * Named entrypoint for service binding access.
 * Service bindings include `entrypoint: "ProxyEntrypoint"` and `props: { projectId, orgId }`
 * set at deploy time, providing unforgeable identity that user code cannot spoof.
 */
export class ProxyEntrypoint extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		// Health check endpoint
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "binding-proxy",
				timestamp: new Date().toISOString(),
			});
		}

		// Resolve identity from ctx.props (preferred) or legacy headers (backward compat)
		const identity = this.resolveIdentity(request);
		if (!identity) {
			return Response.json(
				{
					error: "Missing project identity. This proxy requires ctx.props or X-Jack-* headers.",
				},
				{ status: 403 },
			);
		}

		// AI proxy endpoint
		if (url.pathname === "/ai/run" && request.method === "POST") {
			const handler = new AIHandler(this.env);
			return handler.handleRequest(request, this.ctx, identity);
		}

		// Vectorize proxy endpoint
		if (url.pathname === "/vectorize" && request.method === "POST") {
			const handler = new VectorizeHandler(this.env);
			return handler.handleRequest(request, this.ctx, identity);
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
	}

	/**
	 * Centralized identity resolution with priority:
	 * 1. ctx.props (trusted, set at deploy time — unforgeable)
	 * 2. Legacy X-Jack-* headers (backward compat for old deployments)
	 */
	private resolveIdentity(request: Request): ProxyIdentity | null {
		// Primary: ctx.props injected via service binding at deploy time
		const props = (this.ctx as unknown as { props?: ProxyProps }).props;
		if (props?.projectId && props?.orgId) {
			return {
				projectId: props.projectId,
				orgId: props.orgId,
				source: "props",
			};
		}

		// Fallback: legacy header-based identity (for Workers deployed before this change)
		const projectId = request.headers.get("X-Jack-Project-ID");
		const orgId = request.headers.get("X-Jack-Org-ID");
		if (projectId && orgId) {
			return {
				projectId,
				orgId,
				source: "headers",
			};
		}

		return null;
	}
}

/**
 * Default export handles direct HTTP access (health checks only).
 * Proxy routes accessed without the entrypoint are rejected.
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check is always accessible
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "binding-proxy",
				timestamp: new Date().toISOString(),
			});
		}

		// Reject proxy routes accessed without the entrypoint
		return Response.json(
			{
				error: "Direct access not allowed. Use the ProxyEntrypoint service binding.",
			},
			{ status: 403 },
		);
	},
};
