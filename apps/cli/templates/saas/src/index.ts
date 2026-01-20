// Server-side Worker - handles API routes, keeps secrets secure
/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { cors } from "hono/cors";
import Stripe from "stripe";
import { createAuth } from "./auth";

// Environment bindings and secrets
type Env = {
	// Bindings
	DB: D1Database;
	ASSETS: Fetcher;

	// Secrets (set via `jack secrets set`)
	BETTER_AUTH_SECRET: string;
	BETTER_AUTH_URL?: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	STRIPE_PRO_PRICE_ID?: string;
	STRIPE_ENTERPRISE_PRICE_ID?: string;
};

const app = new Hono<{ Bindings: Env }>();

// CORS for API routes
app.use("/api/*", cors());

// Mount Better Auth handler - handles all auth routes including Stripe webhooks
// Routes: /api/auth/signup, /api/auth/signin, /api/auth/session, /api/auth/stripe/webhook, etc.
app.all("/api/auth/*", async (c) => {
	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

// Health check endpoint
app.get("/api/health", (c) => {
	return c.json({
		status: "ok",
		timestamp: new Date().toISOString(),
	});
});

// Config endpoint - exposes non-sensitive configuration to frontend
app.get("/api/config", (c) => {
	const isStripeTestMode = c.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? true;
	return c.json({
		stripeTestMode: isStripeTestMode,
	});
});

// Get subscription status with real-time Stripe data
app.get("/api/subscription-status", async (c) => {
	try {
		const auth = createAuth(c.env);
		const session = await auth.api.getSession({ headers: c.req.raw.headers });

		if (!session?.user) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY);

		// Find customer by email
		const customers = await stripeClient.customers.list({
			email: session.user.email,
			limit: 1,
		});

		if (customers.data.length === 0) {
			console.log(`[subscription-status] No Stripe customer for: ${session.user.email}`);
			return c.json({ subscription: null });
		}

		// Get subscriptions for this customer (active or scheduled to cancel)
		const subscriptions = await stripeClient.subscriptions.list({
			customer: customers.data[0].id,
			limit: 10,  // Get more to find the right one
			expand: ["data.default_payment_method"],  // Force fresh data
		});

		// Find active or trialing subscription (even if set to cancel at period end)
		const sub = subscriptions.data.find(
			(s) => s.status === "active" || s.status === "trialing"
		);

		if (!sub) {
			console.log(`[subscription-status] No active subscriptions for customer: ${customers.data[0].id}`);
			return c.json({ subscription: null });
		}

		console.log(`[subscription-status] Found: id=${sub.id}, status=${sub.status}, cancel_at_period_end=${sub.cancel_at_period_end}`);

		return c.json({
			subscription: {
				id: sub.id,
				status: sub.status,
				cancelAtPeriodEnd: sub.cancel_at_period_end,
				periodEnd: sub.current_period_end
					? new Date(sub.current_period_end * 1000).toISOString()
					: null,
				plan: sub.items.data[0]?.price?.lookup_key || sub.items.data[0]?.price?.id,
			},
		});
	} catch (err) {
		console.error("[subscription-status] Error:", err);
		return c.json({
			error: "Failed to fetch subscription status",
			details: err instanceof Error ? err.message : String(err)
		}, 500);
	}
});

// Resubscribe - undo a pending cancellation
app.post("/api/resubscribe", async (c) => {
	try {
		const auth = createAuth(c.env);
		const session = await auth.api.getSession({ headers: c.req.raw.headers });

		if (!session?.user) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY);

		// Find customer
		const customers = await stripeClient.customers.list({
			email: session.user.email,
			limit: 1,
		});

		if (customers.data.length === 0) {
			return c.json({ error: "No billing account found" }, 404);
		}

		// Find active subscription set to cancel
		const subscriptions = await stripeClient.subscriptions.list({
			customer: customers.data[0].id,
			status: "active",
			limit: 1,
		});

		if (subscriptions.data.length === 0) {
			return c.json({ error: "No active subscription found" }, 404);
		}

		const sub = subscriptions.data[0];

		// Undo the cancellation in Stripe (if set)
		if (sub.cancel_at_period_end) {
			await stripeClient.subscriptions.update(sub.id, {
				cancel_at_period_end: false,
			});
		}

		// Also clear the local cancelAt in Better Auth's database
		await c.env.DB.prepare(
			"UPDATE subscription SET cancelAt = NULL WHERE stripeSubscriptionId = ?"
		).bind(sub.id).run();

		return c.json({ success: true });
	} catch (err) {
		console.error("[resubscribe] Error:", err);
		return c.json({
			error: "Failed to resubscribe",
			details: err instanceof Error ? err.message : String(err),
		}, 500);
	}
});

// Billing portal - redirects authenticated user to Stripe Customer Portal
app.get("/api/billing-portal", async (c) => {
	const auth = createAuth(c.env);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });

	if (!session?.user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	// Get the Stripe customer ID from the user's subscription
	const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY);

	// Find the customer by email (Better Auth creates customer on signup)
	const customers = await stripeClient.customers.list({
		email: session.user.email,
		limit: 1,
	});

	if (customers.data.length === 0) {
		return c.json({ error: "No billing account found" }, 404);
	}

	const returnUrl = c.req.header("origin") || c.req.header("referer") || c.env.BETTER_AUTH_URL || "/";

	const portalSession = await stripeClient.billingPortal.sessions.create({
		customer: customers.data[0].id,
		return_url: `${returnUrl}/#/dashboard`,
	});

	return c.redirect(portalSession.url);
});

// Serve React app for all other routes
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// Export type for client-side usage with hono/client
export type AppType = typeof app;
export default app;
