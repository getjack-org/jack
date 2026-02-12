import { Hono } from "hono";
import { cors } from "hono/cors";
import { sendEmail, welcomeEmail, notificationEmail } from "./email";

type Bindings = {
	DB: D1Database;
	RESEND_API_KEY: string;
	FROM_EMAIL?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

app.get("/", (c) => {
	return c.json({ message: "Email API running", name: "jack-template" });
});

app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: Date.now() });
});

// Send an email
app.post("/api/send", async (c) => {
	const db = c.env.DB;

	let body: {
		to: string;
		subject?: string;
		html?: string;
		text?: string;
		template?: "welcome" | "notification";
		templateData?: Record<string, string>;
	};

	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	if (!body.to) {
		return c.json({ error: "Missing required field: to" }, 400);
	}

	// Build email options from template or raw fields
	let emailOpts: { to: string; subject: string; html?: string; text?: string };

	if (body.template === "welcome") {
		const name = body.templateData?.name || "there";
		emailOpts = welcomeEmail(body.to, name);
	} else if (body.template === "notification") {
		const title = body.templateData?.title || "Notification";
		const notifBody = body.templateData?.body || "";
		emailOpts = notificationEmail(body.to, title, notifBody);
	} else {
		if (!body.subject) {
			return c.json({ error: "Missing required field: subject" }, 400);
		}
		if (!body.html && !body.text) {
			return c.json(
				{ error: "At least one of html or text is required" },
				400,
			);
		}
		emailOpts = {
			to: body.to,
			subject: body.subject,
			html: body.html,
			text: body.text,
		};
	}

	const result = await sendEmail(c.env, db, emailOpts);

	if (result.success) {
		return c.json({ success: true, id: result.id });
	}
	return c.json({ error: result.error }, 500);
});

// List recent emails
app.get("/api/emails", async (c) => {
	const db = c.env.DB;

	const { results } = await db
		.prepare(
			"SELECT * FROM email_log ORDER BY created_at DESC LIMIT 50",
		)
		.all();

	return c.json({ emails: results });
});

// Email send statistics
app.get("/api/emails/stats", async (c) => {
	const db = c.env.DB;

	const { results } = await db
		.prepare(
			"SELECT status, COUNT(*) as count FROM email_log GROUP BY status",
		)
		.all();

	return c.json({ stats: results });
});

export default app;
