// Centralized plan configuration
// Edit this file to customize plans for your SaaS

export type PlanId = "free" | "pro" | "enterprise";

export interface PlanConfig {
	id: PlanId;
	name: string;
	price: string;
	priceMonthly: number; // For calculations, 0 for free
	description: string;
	features: string[];
	highlighted?: boolean;
}

export const plans: PlanConfig[] = [
	{
		id: "free",
		name: "Free",
		price: "$0",
		priceMonthly: 0,
		description: "Perfect for getting started",
		features: ["Up to 100 users", "Basic analytics", "Community support", "1 project"],
	},
	{
		id: "pro",
		name: "Pro",
		price: "$19",
		priceMonthly: 19,
		description: "For growing businesses",
		features: [
			"Unlimited users",
			"Advanced analytics",
			"Priority support",
			"Unlimited projects",
			"Custom integrations",
			"API access",
		],
		highlighted: true,
	},
	{
		id: "enterprise",
		name: "Enterprise",
		price: "$99",
		priceMonthly: 99,
		description: "For large scale operations",
		features: [
			"Everything in Pro",
			"Dedicated support",
			"Custom SLA",
			"On-premise option",
			"Advanced security",
			"Custom contracts",
		],
	},
];

// Helper functions
export function getPlan(id: PlanId | string): PlanConfig | undefined {
	return plans.find((p) => p.id === id);
}

export function getPlanName(id: PlanId | string): string {
	return getPlan(id)?.name ?? "Free";
}

export function isPaidPlan(id: PlanId | string): boolean {
	const plan = getPlan(id);
	return plan ? plan.priceMonthly > 0 : false;
}

export function canUpgrade(from: PlanId | string, to: PlanId | string): boolean {
	const fromPlan = getPlan(from);
	const toPlan = getPlan(to);
	if (!fromPlan || !toPlan) return false;
	return toPlan.priceMonthly > fromPlan.priceMonthly;
}
