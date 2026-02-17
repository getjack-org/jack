import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DeviceAuthorizationResponse, MagicAuthResponse, TokenResponse } from "./types.ts";

type Bindings = {
	WORKOS_API_KEY: string;
	WORKOS_CLIENT_ID: string;
	MAGIC_AUTH_LIMITER: RateLimit;
};

interface RateLimit {
	limit: (options: { key: string }) => Promise<{ success: boolean }>;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "OPTIONS"],
	}),
);

app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-auth" });
});

// Device Authorization - initiate flow
app.post("/auth/device/authorize", async (c) => {
	const workosResponse = await fetch("https://api.workos.com/user_management/authorize/device", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
		},
		body: JSON.stringify({
			client_id: c.env.WORKOS_CLIENT_ID,
		}),
	});

	if (!workosResponse.ok) {
		const error = await workosResponse.json();
		return c.json({ error: "workos_error", details: error }, 500);
	}

	const data = (await workosResponse.json()) as DeviceAuthorizationResponse;

	return c.json({
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		verification_uri_complete: data.verification_uri_complete,
		expires_in: data.expires_in,
		interval: data.interval,
	});
});

// Token Exchange - poll for device code completion
app.post("/auth/device/token", async (c) => {
	const body = await c.req.json<{ device_code: string }>();

	if (!body.device_code) {
		return c.json({ error: "missing_device_code" }, 400);
	}

	const workosResponse = await fetch("https://api.workos.com/user_management/authenticate", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
		},
		body: JSON.stringify({
			client_id: c.env.WORKOS_CLIENT_ID,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: body.device_code,
		}),
	});

	const data = await workosResponse.json();

	if (data.error === "authorization_pending") {
		return c.json({ status: "pending" }, 202);
	}

	if (data.error === "expired_token") {
		return c.json({ error: "expired", message: "Device code expired" }, 410);
	}

	if (data.error) {
		return c.json({ error: data.error, message: data.error_description }, 400);
	}

	const tokenData = data as TokenResponse;
	return c.json({
		access_token: tokenData.access_token,
		refresh_token: tokenData.refresh_token,
		expires_in: tokenData.expires_in,
		user: {
			id: tokenData.user.id,
			email: tokenData.user.email,
			first_name: tokenData.user.first_name,
			last_name: tokenData.user.last_name,
		},
	});
});

// Magic Auth - send verification code via email
app.post("/auth/magic", async (c) => {
	const body = await c.req.json<{ email: string }>();

	if (!body.email) {
		return c.json({ error: "missing_email", message: "Email is required" }, 400);
	}

	// Rate limit by IP
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	const { success: withinLimit } = await c.env.MAGIC_AUTH_LIMITER.limit({ key: ip });
	if (!withinLimit) {
		return c.json({ error: "rate_limited", message: "Too many requests. Try again later." }, 429);
	}

	const workosResponse = await fetch("https://api.workos.com/user_management/magic_auth", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
		},
		body: JSON.stringify({ email: body.email }),
	});

	if (!workosResponse.ok) {
		const error = await workosResponse.json();
		return c.json({ error: "workos_error", details: error }, 500);
	}

	const data = (await workosResponse.json()) as MagicAuthResponse;

	// Return ONLY the id and email — NOT the code
	return c.json({
		id: data.id,
		email: data.email,
	});
});

// Magic Auth - verify code and exchange for tokens
app.post("/auth/magic/verify", async (c) => {
	const body = await c.req.json<{ email: string; code: string }>();

	if (!body.email || !body.code) {
		return c.json({ error: "missing_fields", message: "Email and code are required" }, 400);
	}

	const workosResponse = await fetch("https://api.workos.com/user_management/authenticate", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
		},
		body: JSON.stringify({
			client_id: c.env.WORKOS_CLIENT_ID,
			client_secret: c.env.WORKOS_API_KEY,
			grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
			code: body.code,
			email: body.email,
		}),
	});

	const data = await workosResponse.json();

	if (data.error === "invalid_grant") {
		return c.json({ error: "invalid_code", message: "Invalid or expired code" }, 400);
	}

	if (data.error === "expired_token" || data.error === "code_expired") {
		return c.json({ error: "expired", message: "Code expired. Please request a new one." }, 410);
	}

	if (data.error) {
		return c.json({ error: data.error, message: data.error_description }, 400);
	}

	const tokenData = data as TokenResponse;
	return c.json({
		access_token: tokenData.access_token,
		refresh_token: tokenData.refresh_token,
		expires_in: tokenData.expires_in,
		user: {
			id: tokenData.user.id,
			email: tokenData.user.email,
			first_name: tokenData.user.first_name,
			last_name: tokenData.user.last_name,
		},
	});
});

// Token Refresh
app.post("/auth/refresh", async (c) => {
	const body = await c.req.json<{ refresh_token: string }>();

	if (!body.refresh_token) {
		return c.json({ error: "missing_refresh_token" }, 400);
	}

	const workosResponse = await fetch("https://api.workos.com/user_management/authenticate", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${c.env.WORKOS_API_KEY}`,
		},
		body: JSON.stringify({
			client_id: c.env.WORKOS_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: body.refresh_token,
		}),
	});

	if (!workosResponse.ok) {
		const error = await workosResponse.json();
		return c.json({ error: "refresh_failed", details: error }, 401);
	}

	const data = (await workosResponse.json()) as TokenResponse;

	return c.json({
		access_token: data.access_token,
		refresh_token: data.refresh_token,
		expires_in: data.expires_in,
		user: {
			id: data.user.id,
			email: data.user.email,
			first_name: data.user.first_name,
			last_name: data.user.last_name,
		},
	});
});

// Current User - decode JWT
app.get("/auth/me", async (c) => {
	const authHeader = c.req.header("Authorization");

	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "unauthorized" }, 401);
	}

	const token = authHeader.slice(7);

	try {
		const [, payloadB64] = token.split(".");
		const payload = JSON.parse(atob(payloadB64));

		return c.json({
			id: payload.sub,
			email: payload.email,
		});
	} catch {
		return c.json({ error: "invalid_token" }, 401);
	}
});

export default app;
