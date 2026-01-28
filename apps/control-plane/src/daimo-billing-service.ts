import type { Bindings, OrgBilling } from "./types";

const DAIMO_API_BASE = "https://pay.daimo.com";
// $20 USDC for 3 months - early adopter pricing
const PRO_PRICE_UNITS = "20.00";
const PERIOD_DAYS = 90;

// Base chain ID and USDC token address
const BASE_CHAIN_ID = 8453;
const USDC_TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface DaimoCreatePaymentResponse {
	id: string;
	url: string;
}

interface DaimoWebhookPayload {
	type: "payment_started" | "payment_completed" | "payment_bounced" | "payment_refunded";
	paymentId: string;
	payment: {
		id: string;
		status: string;
		metadata: Record<string, string> | null;
	};
}

export class DaimoBillingService {
	private db: D1Database;
	private apiKey: string;
	private webhookSecret: string;
	private receiverAddress: string;

	constructor(env: Bindings) {
		this.db = env.DB;
		this.apiKey = env.DAIMO_API_KEY;
		this.webhookSecret = env.DAIMO_WEBHOOK_SECRET;
		this.receiverAddress = env.DAIMO_RECEIVER_ADDRESS;
	}

	async createCheckout(
		orgId: string,
		successUrl: string,
	): Promise<{ url: string; paymentId: string }> {
		const response = await fetch(`${DAIMO_API_BASE}/api/payment`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Api-Key": this.apiKey,
			},
			body: JSON.stringify({
				display: {
					intent: "Jack Cloud Pro - 3 months",
					redirectUri: successUrl,
				},
				destination: {
					destinationAddress: this.receiverAddress,
					chainId: BASE_CHAIN_ID,
					tokenAddress: USDC_TOKEN_ADDRESS,
					amountUnits: PRO_PRICE_UNITS,
				},
				refundAddress: this.receiverAddress,
				metadata: {
					org_id: orgId,
				},
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			console.error("[daimo] Failed to create payment:", error);
			throw new Error(`Failed to create Daimo payment: ${error}`);
		}

		const data = (await response.json()) as DaimoCreatePaymentResponse;
		return { url: data.url, paymentId: data.id };
	}

	async handlePaymentCompleted(paymentId: string, orgId: string): Promise<void> {
		console.log("[daimo] Processing payment completion for org:", orgId, "payment:", paymentId);

		const billing = await this.db
			.prepare("SELECT * FROM org_billing WHERE org_id = ?")
			.bind(orgId)
			.first<OrgBilling>();

		if (!billing) {
			console.error("[daimo] No billing record found for org:", orgId);
			throw new Error(`No billing record found for org: ${orgId}`);
		}

		// Idempotency check: if this exact payment was already processed, skip
		if (billing.daimo_payment_id === paymentId) {
			console.log("[daimo] Payment already processed, skipping:", paymentId);
			return;
		}

		const now = new Date();
		let newPeriodEnd: Date;

		if (billing.current_period_end && billing.payment_provider === "daimo") {
			const currentPeriodEnd = new Date(billing.current_period_end);
			const gracePeriodEnd = new Date(currentPeriodEnd.getTime() + 3 * 24 * 60 * 60 * 1000);

			if (now < currentPeriodEnd) {
				// Early renewal: extend from current period end
				newPeriodEnd = new Date(currentPeriodEnd.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
				console.log("[daimo] Early renewal, extending from current period end");
			} else if (now < gracePeriodEnd) {
				// Late renewal within grace: start fresh from now
				newPeriodEnd = new Date(now.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
				console.log("[daimo] Grace period renewal, starting from now");
			} else {
				// Very late or first payment: start from now
				newPeriodEnd = new Date(now.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
				console.log("[daimo] First payment or past grace period, starting from now");
			}
		} else {
			// First Daimo payment
			newPeriodEnd = new Date(now.getTime() + PERIOD_DAYS * 24 * 60 * 60 * 1000);
			console.log("[daimo] First Daimo payment for org");
		}

		await this.db
			.prepare(
				`UPDATE org_billing SET
				plan_tier = 'pro',
				plan_status = 'active',
				daimo_payment_id = ?,
				payment_provider = 'daimo',
				current_period_start = ?,
				current_period_end = ?,
				updated_at = CURRENT_TIMESTAMP
			WHERE org_id = ?`,
			)
			.bind(paymentId, now.toISOString(), newPeriodEnd.toISOString(), orgId)
			.run();

		console.log(
			"[daimo] Successfully updated billing for org:",
			orgId,
			"period ends:",
			newPeriodEnd.toISOString(),
		);
	}

	verifyWebhook(authHeader: string | undefined): boolean {
		if (!authHeader) return false;
		const expected = `Basic ${this.webhookSecret}`;
		return authHeader === expected;
	}

	parseWebhookPayload(body: unknown): {
		type: string;
		paymentId: string;
		orgId: string | null;
	} | null {
		const payload = body as DaimoWebhookPayload;
		if (!payload.type || !payload.paymentId) {
			return null;
		}
		return {
			type: payload.type,
			paymentId: payload.paymentId,
			orgId: payload.payment?.metadata?.org_id ?? null,
		};
	}

	isPaymentCompletedEvent(type: string): boolean {
		return type === "payment_completed";
	}

	hasActiveDaimoSubscription(billing: OrgBilling): boolean {
		if (billing.payment_provider !== "daimo") return false;
		if (!billing.current_period_end) return false;
		const periodEnd = new Date(billing.current_period_end);
		const gracePeriodEnd = new Date(periodEnd.getTime() + 3 * 24 * 60 * 60 * 1000);
		return new Date() < gracePeriodEnd;
	}
}
