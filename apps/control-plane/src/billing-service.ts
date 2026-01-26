import Stripe from "stripe";
import type { Bindings, OrgBilling, PAID_STATUSES, PlanStatus, PlanTier } from "./types";

export class BillingService {
	private stripe: Stripe;
	private db: D1Database;

	constructor(env: Bindings) {
		this.stripe = new Stripe(env.STRIPE_SECRET_KEY, {
			apiVersion: "2025-02-24.acacia",
		});
		this.db = env.DB;
	}

	// Get or create org billing record
	async getOrCreateBilling(orgId: string): Promise<OrgBilling> {
		let billing = await this.db
			.prepare("SELECT * FROM org_billing WHERE org_id = ?")
			.bind(orgId)
			.first<OrgBilling>();

		if (!billing) {
			await this.db
				.prepare(
					`INSERT INTO org_billing (org_id, plan_tier, plan_status) VALUES (?, 'free', 'active')`,
				)
				.bind(orgId)
				.run();
			billing = await this.db
				.prepare("SELECT * FROM org_billing WHERE org_id = ?")
				.bind(orgId)
				.first<OrgBilling>();
		}
		return billing!;
	}

	// Create Stripe customer if needed
	async ensureStripeCustomer(orgId: string, email: string, orgName: string): Promise<string> {
		const billing = await this.getOrCreateBilling(orgId);

		if (billing.stripe_customer_id) {
			return billing.stripe_customer_id;
		}

		const customer = await this.stripe.customers.create({
			email,
			name: orgName,
			metadata: { org_id: orgId },
		});

		await this.db
			.prepare(
				"UPDATE org_billing SET stripe_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE org_id = ?",
			)
			.bind(customer.id, orgId)
			.run();

		return customer.id;
	}

	// Create checkout session for upgrade
	async createCheckoutSession(
		orgId: string,
		customerId: string,
		priceId: string,
		successUrl: string,
		cancelUrl: string,
	): Promise<string> {
		const session = await this.stripe.checkout.sessions.create({
			customer: customerId,
			payment_method_types: ["card"],
			line_items: [{ price: priceId, quantity: 1 }],
			mode: "subscription",
			success_url: successUrl,
			cancel_url: cancelUrl,
			metadata: { org_id: orgId },
			subscription_data: { metadata: { org_id: orgId } },
		});
		return session.url!;
	}

	// Create billing portal session
	async createPortalSession(customerId: string, returnUrl: string): Promise<string> {
		const session = await this.stripe.billingPortal.sessions.create({
			customer: customerId,
			return_url: returnUrl,
		});
		return session.url;
	}

	// Update billing from webhook
	async syncFromStripeSubscription(subscription: Stripe.Subscription): Promise<void> {
		const orgId = subscription.metadata.org_id;
		if (!orgId) {
			console.error("No org_id in subscription metadata");
			return;
		}

		console.log("[billing] Syncing subscription for org:", orgId);
		console.log("[billing] Subscription status:", subscription.status);
		console.log("[billing] Period start:", subscription.current_period_start);
		console.log("[billing] Period end:", subscription.current_period_end);

		// Map Stripe price to our tier
		const priceId = subscription.items.data[0]?.price.id;
		const planTier = this.priceToTier(priceId);
		console.log("[billing] Price ID:", priceId, "-> Tier:", planTier);

		// Stripe status maps directly to our plan_status
		const planStatus = subscription.status as PlanStatus;

		// Safely convert timestamps (Stripe returns Unix timestamps in seconds)
		const periodStart = subscription.current_period_start
			? new Date(subscription.current_period_start * 1000).toISOString()
			: null;
		const periodEnd = subscription.current_period_end
			? new Date(subscription.current_period_end * 1000).toISOString()
			: null;

		await this.db
			.prepare(
				`UPDATE org_billing SET
				plan_tier = ?,
				plan_status = ?,
				stripe_subscription_id = ?,
				stripe_price_id = ?,
				stripe_product_id = ?,
				stripe_status = ?,
				current_period_start = ?,
				current_period_end = ?,
				cancel_at_period_end = ?,
				updated_at = CURRENT_TIMESTAMP
			WHERE org_id = ?`,
			)
			.bind(
				planTier,
				planStatus,
				subscription.id,
				priceId ?? null,
				(subscription.items.data[0]?.price.product as string) ?? null,
				subscription.status,
				periodStart,
				periodEnd,
				subscription.cancel_at_period_end ? 1 : 0,
				orgId,
			)
			.run();

		console.log("[billing] Successfully updated billing for org:", orgId);
	}

	// Handle subscription deletion
	async handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
		const orgId = subscription.metadata.org_id;
		if (!orgId) return;

		await this.db
			.prepare(
				`UPDATE org_billing SET
				plan_tier = 'free',
				plan_status = 'canceled',
				stripe_status = 'canceled',
				cancel_at_period_end = 0,
				updated_at = CURRENT_TIMESTAMP
			WHERE org_id = ?`,
			)
			.bind(orgId)
			.run();
	}

	// Map Stripe price ID to our tier
	// Configure by setting price IDs in Stripe dashboard and matching here
	private priceToTier(priceId: string | undefined): PlanTier {
		if (!priceId) return "free";
		// For MVP, all non-free subscriptions are 'pro'
		// TODO: Add price_id -> tier mapping when we have multiple tiers
		// e.g., if (priceId === 'price_team_xxx') return 'team';
		return "pro";
	}

	// Check if org has paid tier (active, trialing, or past_due which has grace period)
	isPaidTier(billing: OrgBilling): boolean {
		const paidStatuses: PlanStatus[] = ["active", "trialing", "past_due"];
		return billing.plan_tier !== "free" && paidStatuses.includes(billing.plan_status);
	}

	// Check if org already has an active subscription
	hasActiveSubscription(billing: OrgBilling): boolean {
		const activeStatuses: PlanStatus[] = ["active", "trialing", "past_due"];
		return !!billing.stripe_subscription_id && activeStatuses.includes(billing.plan_status);
	}

	// Verify Stripe webhook signature (async for Cloudflare Workers compatibility)
	async verifyWebhookSignature(
		payload: string,
		signature: string,
		secret: string,
	): Promise<Stripe.Event> {
		return await this.stripe.webhooks.constructEventAsync(payload, signature, secret);
	}
}
