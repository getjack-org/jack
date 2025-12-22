import type { Context, MiddlewareHandler } from "hono";
import { verifyJwt } from "./verify.ts";
import type { AuthContext, JwtPayload } from "./types.ts";

// Extend Hono context with auth
declare module "hono" {
	interface ContextVariableMap {
		auth: AuthContext;
		jwtPayload: JwtPayload;
	}
}

/**
 * Hono middleware for JWT authentication
 * Extracts Bearer token, verifies with JWKS, and sets auth context
 */
export function authMiddleware(): MiddlewareHandler {
	return async (c: Context, next) => {
		const authHeader = c.req.header("Authorization");

		if (!authHeader?.startsWith("Bearer ")) {
			return c.json(
				{ error: "unauthorized", message: "Missing or invalid Authorization header" },
				401,
			);
		}

		const token = authHeader.slice(7);

		try {
			const payload = await verifyJwt(token);

			// Set auth context for downstream handlers
			c.set("auth", {
				userId: payload.sub,
				email: payload.email,
				firstName: payload.first_name,
				lastName: payload.last_name,
			});
			c.set("jwtPayload", payload);

			await next();
		} catch (error) {
			const message = error instanceof Error ? error.message : "Token verification failed";
			return c.json({ error: "unauthorized", message }, 401);
		}
	};
}
