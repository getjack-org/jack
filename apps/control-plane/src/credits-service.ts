import type { Bindings, Credit } from "./types";

export class CreditsService {
	private db: D1Database;

	constructor(env: Bindings) {
		this.db = env.DB;
	}

	// Get total bonus domains from ALL active credits (referrals + manual)
	async getTotalBonusDomains(orgId: string): Promise<number> {
		const result = await this.db
			.prepare(
				"SELECT COALESCE(SUM(amount), 0) as total FROM credits WHERE org_id = ? AND status = 'active'",
			)
			.bind(orgId)
			.first<{ total: number }>();
		return result?.total ?? 0;
	}

	// Get referral stats for an org
	async getReferrals(orgId: string): Promise<{
		code: string | null;
		successful: number;
		pending: number;
	}> {
		// Get username as referral code
		const user = await this.db
			.prepare(
				`
			SELECT u.username FROM users u
			JOIN org_memberships om ON u.id = om.user_id
			WHERE om.org_id = ? LIMIT 1
		`,
			)
			.bind(orgId)
			.first<{ username: string | null }>();

		const code = user?.username ?? null;

		// Count successful (my active 'referral_given' credits)
		const successful = await this.db
			.prepare(
				"SELECT COUNT(*) as count FROM credits WHERE org_id = ? AND type = 'referral_given' AND status = 'active'",
			)
			.bind(orgId)
			.first<{ count: number }>();

		// Pending = OTHER users' pending credits where code = my username
		const pending = code
			? await this.db
					.prepare(
						"SELECT COUNT(*) as count FROM credits WHERE code = ? AND type = 'referral_received' AND status = 'pending'",
					)
					.bind(code)
					.first<{ count: number }>()
			: { count: 0 };

		return {
			code,
			successful: successful?.count ?? 0,
			pending: pending?.count ?? 0,
		};
	}

	// Record referral at signup (creates pending credit for referred user)
	async recordReferralSignup(
		referredOrgId: string,
		referralCode: string,
	): Promise<{
		applied: boolean;
		reason?: "invalid" | "self_referral" | "already_referred";
	}> {
		// Check if already referred
		const existing = await this.db
			.prepare("SELECT id FROM credits WHERE org_id = ? AND type = 'referral_received'")
			.bind(referredOrgId)
			.first();
		if (existing) {
			return { applied: false, reason: "already_referred" };
		}

		// Look up referrer by username
		const referrer = await this.db
			.prepare(
				`
				SELECT o.id as org_id FROM users u
				JOIN org_memberships om ON u.id = om.user_id
				JOIN orgs o ON om.org_id = o.id
				WHERE u.username = ?
				ORDER BY om.created_at ASC LIMIT 1
			`,
			)
			.bind(referralCode)
			.first<{ org_id: string }>();

		if (!referrer) {
			return { applied: false, reason: "invalid" };
		}

		// Prevent self-referral
		if (referrer.org_id === referredOrgId) {
			return { applied: false, reason: "self_referral" };
		}

		// Create pending credit for referred user
		const id = crypto.randomUUID();
		await this.db
			.prepare(
				`
				INSERT INTO credits (id, org_id, type, status, amount, code, source_org_id)
				VALUES (?, ?, 'referral_received', 'pending', 1, ?, ?)
			`,
			)
			.bind(id, referredOrgId, referralCode, referrer.org_id)
			.run();

		return { applied: true };
	}

	// Qualify referral on payment - activates credits for both parties
	async qualifyReferral(orgId: string): Promise<void> {
		// Find pending referral_received credit
		const pending = await this.db
			.prepare(
				"SELECT * FROM credits WHERE org_id = ? AND type = 'referral_received' AND status = 'pending'",
			)
			.bind(orgId)
			.first<Credit>();

		if (!pending || !pending.source_org_id) return;

		// Activate the referred user's credit
		await this.db
			.prepare("UPDATE credits SET status = 'active' WHERE id = ?")
			.bind(pending.id)
			.run();

		// Create active credit for the referrer
		const referrerId = crypto.randomUUID();
		await this.db
			.prepare(
				`
				INSERT INTO credits (id, org_id, type, status, amount, code, source_org_id)
				VALUES (?, ?, 'referral_given', 'active', 1, ?, ?)
			`,
			)
			.bind(referrerId, pending.source_org_id, pending.code, orgId)
			.run();
	}
}
