// Server-side Worker - handles API routes, keeps secrets secure

import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
	DB: D1Database;
	NEYNAR_API_KEY: string;
	ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

// CORS for local dev
app.use("/api/*", cors());

// GET /api/notifications?fid=123
app.get("/api/notifications", async (c) => {
	const fid = c.req.query("fid");
	if (!fid) {
		return c.json({ error: "fid is required" }, 400);
	}

	try {
		// Proxy to Neynar API
		const neynarUrl = new URL("https://api.neynar.com/v2/farcaster/notifications/");
		neynarUrl.searchParams.set("fid", fid);
		neynarUrl.searchParams.set("limit", "15");

		const response = await fetch(neynarUrl.toString(), {
			headers: {
				"x-api-key": c.env.NEYNAR_API_KEY,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const error = await response.text();
			return c.json({ error: "Neynar API error", details: error }, response.status as any);
		}

		return c.json(await response.json());
	} catch (error) {
		return c.json({ error: "Failed to fetch notifications" }, 500);
	}
});

// GET /api/guestbook - fetch recent entries
app.get("/api/guestbook", async (c) => {
	try {
		const { results } = await c.env.DB.prepare(
			"SELECT * FROM guestbook ORDER BY created_at DESC LIMIT 50",
		).all();
		return c.json({ entries: results });
	} catch (error) {
		return c.json({ error: "Failed to fetch guestbook entries" }, 500);
	}
});

// POST /api/guestbook - add entry
app.post("/api/guestbook", async (c) => {
	try {
		const body = await c.req.json<{
			fid: number;
			username: string;
			displayName?: string;
			pfpUrl?: string;
			message: string;
		}>();

		// Validate
		if (!body.fid || !body.username || !body.message) {
			return c.json({ error: "fid, username, and message are required" }, 400);
		}

		// Trim and validate message (max 140 chars)
		const message = body.message.trim().slice(0, 140);
		if (!message) {
			return c.json({ error: "Message cannot be empty" }, 400);
		}

		const result = await c.env.DB.prepare(
			"INSERT INTO guestbook (fid, username, display_name, pfp_url, message) VALUES (?, ?, ?, ?, ?) RETURNING *",
		)
			.bind(body.fid, body.username, body.displayName || null, body.pfpUrl || null, message)
			.first();

		return c.json({ entry: result }, 201);
	} catch (error) {
		return c.json({ error: "Failed to add guestbook entry" }, 500);
	}
});

// Serve React app for all other routes
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Export type for hono/client
export type AppType = typeof app;
export default app;
