import { Hono } from "hono";
import { cors } from "hono/cors";
import { createJob, getPendingJobs, processJob, retryFailedJobs } from "./jobs";
import { logWebhookEvent, verifyWebhookSignature } from "./webhooks";

type Bindings = {
	DB: D1Database;
	WEBHOOK_SECRET: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

app.get("/", (c) => {
	return c.json({
		message: "Background worker running",
		name: "jack-template",
	});
});

app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: Date.now() });
});

// Cron handler - called by scheduler on POST /__scheduled
app.post("/__scheduled", async (c) => {
	const db = c.env.DB;

	// Retry failed jobs that haven't exceeded max attempts
	const retried = await retryFailedJobs(db);

	// Get pending jobs that are ready to run
	const jobs = await getPendingJobs(db, 10);
	let processed = 0;

	for (const job of jobs) {
		await processJob(db, job);
		processed++;
	}

	return c.json({ processed, retried });
});

// Webhook ingestion endpoint
app.post("/webhook", async (c) => {
	const db = c.env.DB;
	const body = await c.req.text();
	const signature = c.req.header("X-Signature") || "";

	// Verify webhook signature
	const valid = await verifyWebhookSignature(
		body,
		signature,
		c.env.WEBHOOK_SECRET,
	);
	if (!valid) {
		return c.json({ error: "Invalid signature" }, 401);
	}

	// Parse and log the event
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body);
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const eventType = (parsed.event as string) || "unknown";
	const source = (parsed.source as string) || "unknown";

	const eventId = await logWebhookEvent(db, {
		source,
		eventType,
		payload: body,
	});

	// Create a job from the webhook event for async processing
	await createJob(db, {
		type: `webhook.${eventType}`,
		payload: { webhookEventId: eventId, data: parsed.data || {} },
	});

	return c.json({ received: true, id: eventId });
});

// List recent jobs
app.get("/jobs", async (c) => {
	const db = c.env.DB;

	const { results } = await db
		.prepare(
			"SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50",
		)
		.all();

	return c.json({ jobs: results });
});

// Get a single job by ID
app.get("/jobs/:id", async (c) => {
	const db = c.env.DB;
	const id = c.req.param("id");

	const job = await db
		.prepare("SELECT * FROM jobs WHERE id = ?")
		.bind(id)
		.first();

	if (!job) {
		return c.json({ error: "Job not found" }, 404);
	}

	return c.json({ job });
});

export default app;
