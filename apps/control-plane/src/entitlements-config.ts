import type { PlanTier } from "./types";

// Base limits per plan tier
export const TIER_LIMITS: Record<PlanTier, { custom_domains: number }> = {
	free: { custom_domains: 1 }, // Set to 0 when platform hits 100 domains
	pro: { custom_domains: 3 },
	team: { custom_domains: 10 },
};

// What ONE successful referral grants
export const REFERRAL_BONUS = {
	custom_domains: 1,
} as const;

// Max bonus from referrals
export const REFERRAL_CAP = {
	custom_domains: 25,
} as const;

// Compute final limits for an org
export function computeLimits(
	tier: PlanTier,
	successfulReferrals: number,
): { custom_domains: number } {
	const base = TIER_LIMITS[tier];
	if (!base) throw new Error(`Unknown tier: ${tier}`);

	return {
		custom_domains:
			base.custom_domains +
			Math.min(successfulReferrals * REFERRAL_BONUS.custom_domains, REFERRAL_CAP.custom_domains),
	};
}
