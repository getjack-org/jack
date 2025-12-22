import { Hono } from "hono";
import { cors } from "hono/cors";
import { authMiddleware } from "@getjack/auth";

type Bindings = {
	DB: D1Database;
};

const app = new Hono<{ Bindings: Bindings }>();

// CORS for all routes
app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
	}),
);

// Health check (public)
app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-api" });
});

// Protected routes - require valid JWT
const api = new Hono<{ Bindings: Bindings }>();
api.use("/*", authMiddleware());

// GET /api/users/me - Get or create current user
api.get("/users/me", async (c) => {
	const auth = c.get("auth");

	// Try to find existing user
	let user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(auth.userId).first();

	// Create user if not exists (upsert on first login)
	if (!user) {
		await c.env.DB.prepare(
			`INSERT INTO users (id, email, first_name, last_name)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         updated_at = CURRENT_TIMESTAMP`,
		)
			.bind(auth.userId, auth.email, auth.firstName || null, auth.lastName || null)
			.run();

		user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(auth.userId).first();
	}

	return c.json({ user });
});

// PUT /api/users/me - Update current user profile
api.put("/users/me", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{
		first_name?: string;
		last_name?: string;
	}>();

	await c.env.DB.prepare(
		`UPDATE users SET
       first_name = COALESCE(?, first_name),
       last_name = COALESCE(?, last_name),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(body.first_name ?? null, body.last_name ?? null, auth.userId)
		.run();

	const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(auth.userId).first();

	return c.json({ user });
});

// Mount protected API routes
app.route("/api", api);

export default app;
