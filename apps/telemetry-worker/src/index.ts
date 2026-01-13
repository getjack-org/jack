import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings, IdentifyEvent, TelemetryEvent } from "./types.ts";

const app = new Hono<{ Bindings: Bindings }>();

const POSTHOG_HOST = "https://eu.i.posthog.com";
const RATE_LIMIT_MAX = 100; // requests per hour per IP
const RATE_WINDOW = 3600; // 1 hour in seconds

app.use("/*", cors({ origin: "*" }));

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "jack-telemetry" }));

// Rate limit helper
async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
	const key = `rl:${ip}`;
	const current = await kv.get(key);
	const count = current ? Number.parseInt(current, 10) : 0;

	if (count >= RATE_LIMIT_MAX) return false;

	await kv.put(key, String(count + 1), { expirationTtl: RATE_WINDOW });
	return true;
}

// Validate telemetry payload
function isValidEvent(payload: unknown): payload is TelemetryEvent {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as Record<string, unknown>;
	return typeof p.distinctId === "string" && typeof p.event === "string";
}

function isValidIdentify(payload: unknown): payload is IdentifyEvent {
	if (!payload || typeof payload !== "object") return false;
	const p = payload as Record<string, unknown>;
	return typeof p.distinctId === "string" && typeof p.properties === "object";
}

// Track event endpoint
app.post("/t", async (c) => {
	const ip = c.req.header("cf-connecting-ip") || "unknown";

	// Rate limit
	if (!(await checkRateLimit(c.env.RATE_LIMIT, ip))) {
		return c.json({ error: "rate_limited" }, 429);
	}

	// Parse payload (sendBeacon sends as text/plain, so try both)
	let payload: unknown;
	try {
		const text = await c.req.text();
		payload = JSON.parse(text);
	} catch {
		return c.json({ error: "invalid_payload" }, 400);
	}
	if (!isValidEvent(payload)) {
		return c.json({ error: "invalid_payload" }, 400);
	}

	// Forward to PostHog
	const posthogPayload = {
		api_key: c.env.POSTHOG_API_KEY,
		distinct_id: payload.distinctId,
		event: payload.event,
		properties: {
			...payload.properties,
			$ip: ip, // Pass real user IP for geo detection
			$timestamp: payload.timestamp || Date.now(),
		},
	};

	c.executionCtx.waitUntil(
		fetch(`${POSTHOG_HOST}/capture`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(posthogPayload),
		}).catch(() => {}),
	);

	return c.json({ status: "ok" });
});

// Identify endpoint
app.post("/identify", async (c) => {
	const ip = c.req.header("cf-connecting-ip") || "unknown";

	if (!(await checkRateLimit(c.env.RATE_LIMIT, ip))) {
		return c.json({ error: "rate_limited" }, 429);
	}

	// Parse payload (sendBeacon sends as text/plain, so try both)
	let payload: unknown;
	try {
		const text = await c.req.text();
		payload = JSON.parse(text);
	} catch {
		return c.json({ error: "invalid_payload" }, 400);
	}
	if (!isValidIdentify(payload)) {
		return c.json({ error: "invalid_payload" }, 400);
	}

	// Forward to PostHog (fire and forget)
	c.executionCtx.waitUntil(
		fetch(`${POSTHOG_HOST}/capture`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: c.env.POSTHOG_API_KEY,
				distinct_id: payload.distinctId,
				event: "$identify",
				properties: {
					...payload.properties,
					$ip: ip, // Pass real user IP for geo detection
				},
				$set: payload.properties,
				...(payload.setOnce && { $set_once: payload.setOnce }),
			}),
		}).catch(() => {}),
	);

	return c.json({ status: "ok" });
});

export default app;
