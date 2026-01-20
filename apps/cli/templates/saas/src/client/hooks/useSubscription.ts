import { useState, useEffect } from "react";
import { authClient } from "../lib/auth-client";

type Subscription = {
	id: string;
	plan: string;
	status: string;
	stripeCustomerId?: string;
	stripeSubscriptionId?: string;
	cancelAtPeriodEnd?: boolean;
	cancelAt?: Date | string | null;  // Better Auth uses this
	periodEnd?: Date | string | null;
};

type StripeStatus = {
	id: string;
	status: string;
	cancelAtPeriodEnd: boolean;
	periodEnd: string;
	plan: string;
} | null;

export function useSubscription() {
	const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
	const [stripeStatus, setStripeStatus] = useState<StripeStatus>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		const fetchData = async () => {
			try {
				// Fetch from Better Auth
				const result = await authClient.subscription.list();
				console.log("[useSubscription] Better Auth subscriptions:", result);
				if ("data" in result && result.data) {
					setSubscriptions(result.data as Subscription[]);
				}

				// Fetch real-time status from Stripe
				const stripeRes = await fetch("/api/subscription-status");
				const stripeData = await stripeRes.json();
				console.log("[useSubscription] Stripe status response:", stripeRes.status, stripeData);
				if (stripeRes.ok && stripeData.subscription) {
					setStripeStatus(stripeData.subscription);
				}
			} catch (err) {
				setError(err as Error);
			}
			setIsLoading(false);
		};

		fetchData();
	}, []);

	const activeSubscription = subscriptions.find(
		(s) => s.status === "active" || s.status === "trialing",
	);

	// Check if cancelling: Stripe uses cancelAtPeriodEnd, Better Auth uses cancelAt (date)
	const isCancelling =
		stripeStatus?.cancelAtPeriodEnd ||
		activeSubscription?.cancelAtPeriodEnd ||
		!!activeSubscription?.cancelAt ||  // Better Auth sets cancelAt date when cancelling
		false;

	// Get period end from either source
	const periodEnd = stripeStatus?.periodEnd ||
		(activeSubscription?.periodEnd ? String(activeSubscription.periodEnd) : null);

	return {
		subscriptions,
		activeSubscription: activeSubscription ?? null,
		plan: activeSubscription?.plan ?? "free",
		isSubscribed: !!activeSubscription,
		isCancelling,
		periodEnd,
		isLoading,
		error,
		upgrade: (plan: "pro" | "enterprise") =>
			authClient.subscription.upgrade({
				plan,
				successUrl: `${window.location.origin}/#/dashboard?upgraded=true`,
				cancelUrl: `${window.location.origin}/#/pricing`,
			}),
	};
}
