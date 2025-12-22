import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

app.use("/*", cors());

app.get("/", (c) => {
	return c.json({ message: "Hello from jack-template!" });
});

app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: Date.now() });
});

// Example: POST endpoint
app.post("/api/echo", async (c) => {
	const body = await c.req.json();
	return c.json({ received: body });
});

// Example: URL params
app.get("/api/users/:id", (c) => {
	const id = c.req.param("id");
	return c.json({ userId: id });
});

export default app;
