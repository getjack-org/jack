import { betterAuth } from "better-auth";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

// Env type is defined in index.ts and passed from the worker
type Env = {
	DB: D1Database;
	BETTER_AUTH_SECRET: string;
	STRIPE_SECRET_KEY: string;
	STRIPE_WEBHOOK_SECRET?: string; // Optional until webhook is configured
	STRIPE_PRO_PRICE_ID?: string;
	STRIPE_ENTERPRISE_PRICE_ID?: string;
};

export function createAuth(env: Env) {
	const stripeClient = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

	// Build plugins array - Stripe plugin only if we have the API key
	const plugins = [];

	if (env.STRIPE_SECRET_KEY && stripeClient) {
		// Validate required Stripe configuration
		const missingConfig: string[] = [];
		if (!env.STRIPE_PRO_PRICE_ID) missingConfig.push("STRIPE_PRO_PRICE_ID");
		if (!env.STRIPE_ENTERPRISE_PRICE_ID) missingConfig.push("STRIPE_ENTERPRISE_PRICE_ID");
		if (!env.STRIPE_WEBHOOK_SECRET) missingConfig.push("STRIPE_WEBHOOK_SECRET");

		if (missingConfig.length > 0) {
			console.error(`[Stripe] Missing required config: ${missingConfig.join(", ")}`);
			console.error("[Stripe] Subscriptions will not work correctly. Set these secrets via: jack secrets set <KEY> <value>");
		}

		// Only enable Stripe plugin if we have the minimum required config
		if (env.STRIPE_WEBHOOK_SECRET) {
			plugins.push(
				stripe({
					stripeClient,
					stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
					createCustomerOnSignUp: true,
					subscription: {
						enabled: true,
						plans: [
							{ name: "pro", priceId: env.STRIPE_PRO_PRICE_ID || "" },
							{ name: "enterprise", priceId: env.STRIPE_ENTERPRISE_PRICE_ID || "" },
						],
					},
				}),
			);
		} else {
			console.error("[Stripe] Plugin DISABLED - STRIPE_WEBHOOK_SECRET is required for reliable subscription sync");
		}
	}

	// Use Kysely with D1 dialect - Better Auth uses Kysely internally for D1
	const db = new Kysely<any>({
		dialect: new D1Dialect({ database: env.DB }),
	});

	return betterAuth({
		database: {
			db,
			type: "sqlite",
		},
		emailAndPassword: {
			enabled: true,
			sendResetPassword: async ({ user, url }) => {
				// TODO: Configure email sending (Resend, SendGrid, etc.)
				// For now, log the reset URL for development
				console.log(`[Password Reset] User: ${user.email}, URL: ${url}`);
			},
		},
		secret: env.BETTER_AUTH_SECRET,
		plugins,
	});
}
