import { useEffect, useState } from "react";
import { authClient } from "../lib/auth-client";
import { toast } from "sonner";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { ThemeToggle } from "../components/ThemeToggle";
import { plans, getPlanName, isPaidPlan, type PlanId, type PlanConfig } from "../lib/plans";

interface PricingPageProps {
	navigate: (route: "/" | "/login" | "/signup" | "/pricing" | "/dashboard" | "/forgot-password" | "/reset-password") => void;
}

export default function PricingPage({ navigate }: PricingPageProps) {
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [currentPlan, setCurrentPlan] = useState<PlanId | null>(null);
	const [isCancelling, setIsCancelling] = useState(false);
	const [periodEnd, setPeriodEnd] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [upgradeLoading, setUpgradeLoading] = useState<PlanId | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [stripeTestMode, setStripeTestMode] = useState(true);

	useEffect(() => {
		// Fetch config to check if Stripe is in test mode
		fetch("/api/config")
			.then((res) => res.json())
			.then((data) => setStripeTestMode(data.stripeTestMode ?? true))
			.catch(() => setStripeTestMode(true)); // Default to showing test banner on error
	}, []);

	useEffect(() => {
		const checkSession = async () => {
			try {
				const result = await authClient.getSession();
				if (result.data?.user) {
					setIsLoggedIn(true);
					// Check subscription status from Better Auth
					try {
						const subscription = await authClient.subscription.list();
						const activeSub = subscription?.data?.find(
							(s: { status: string }) => s.status === "active" || s.status === "trialing"
						);
						if (activeSub?.plan) {
							setCurrentPlan(activeSub.plan as PlanId);
							// Better Auth uses cancelAt (date) to indicate pending cancellation
							if (activeSub.cancelAt) {
								setIsCancelling(true);
								setPeriodEnd(String(activeSub.periodEnd || activeSub.cancelAt));
							}
						} else {
							setCurrentPlan("free");
						}

						// Also check Stripe for real-time status
						const stripeRes = await fetch("/api/subscription-status");
						if (stripeRes.ok) {
							const data = await stripeRes.json();
							if (data.subscription?.cancelAtPeriodEnd) {
								setIsCancelling(true);
								setPeriodEnd(data.subscription.periodEnd ?? null);
							}
						}
					} catch (subErr) {
						console.error("Failed to load subscription:", subErr);
						setCurrentPlan("free");
					}
				}
			} catch (err) {
				// Not logged in
			}
			setIsLoading(false);
		};
		checkSession();
	}, []);

	const handleUpgrade = async (plan: PlanId) => {
		setError(null);

		if (!isLoggedIn) {
			navigate("/signup");
			return;
		}

		if (plan === "free") {
			// Downgrade = cancel subscription
			setUpgradeLoading("free");
			try {
				const result = await authClient.subscription.cancel({
					returnUrl: `${window.location.origin}/#/pricing?downgraded=true`,
				});
				if (result?.error) {
					const errorMsg = result.error.message || "";
					// If already cancelling, treat as success
					if (errorMsg.includes("already set to be canceled")) {
						setIsCancelling(true);
						toast.success("Subscription is set to cancel", {
							description: "You'll have access until the end of your billing period.",
						});
					} else {
						setError(errorMsg || "Failed to cancel subscription.");
					}
				} else if (result?.data?.url) {
					window.location.href = result.data.url;
				} else {
					// Cancelled immediately
					setIsCancelling(true);
					setError(null);
					toast.success("Subscription cancelled", {
						description: "You'll have access until the end of your billing period.",
					});
				}
			} catch (err) {
				console.error("Cancel error:", err);
				setError("Failed to cancel subscription. Please try again or contact support.");
			}
			setUpgradeLoading(null);
			return;
		}

		// If cancelling and clicking current plan = resubscribe (undo cancellation)
		if (isCancelling && plan === currentPlan) {
			setUpgradeLoading(plan);
			try {
				const res = await fetch("/api/resubscribe", { method: "POST" });
				const data = await res.json();
				if (res.ok && data.success) {
					setIsCancelling(false);
					toast.success("Resubscribed successfully", {
						description: "Your subscription will continue as normal.",
					});
				} else {
					setError(data.error || "Failed to resubscribe.");
				}
			} catch (err) {
				console.error("Resubscribe error:", err);
				setError("Failed to resubscribe. Please try again.");
			}
			setUpgradeLoading(null);
			return;
		}

		setUpgradeLoading(plan);

		try {
			const result = await authClient.subscription.upgrade({
				plan,
				successUrl: `${window.location.origin}/#/dashboard?upgraded=true`,
				cancelUrl: `${window.location.origin}/#/pricing`,
			});
			if (result?.error) {
				setError(result.error.message || "Failed to upgrade. Please try again.");
			} else if (result?.data?.url) {
				// Redirect to Stripe checkout
				window.location.href = result.data.url;
			}
		} catch (err) {
			console.error("Upgrade error:", err);
			setError("An unexpected error occurred. Please try again.");
		}

		setUpgradeLoading(null);
	};

	const getButtonText = (plan: PlanConfig) => {
		if (!isLoggedIn) {
			return plan.id === "free" ? "Get started" : "Start free trial";
		}

		// When user is cancelling their current paid plan
		if (isCancelling && isPaidPlan(currentPlan || "free")) {
			if (plan.id === currentPlan) {
				// Their current plan - offer to undo cancellation
				return "Resubscribe";
			}
			if (plan.id === "free") {
				// Free plan - this is where they're heading after cancellation
				return "After period ends";
			}
			// Other paid plans - can still switch
			return "Switch plan";
		}

		// Normal flow (not cancelling)
		if (currentPlan === plan.id) {
			return "Current plan";
		}

		if (plan.id === "free") {
			return "Downgrade";
		}

		return "Upgrade";
	};

	const isButtonDisabled = (plan: PlanConfig) => {
		if (isLoading || upgradeLoading !== null) return true;

		// When cancelling: only disable Free (they're already heading there)
		if (isCancelling && isPaidPlan(currentPlan || "free")) {
			if (plan.id === "free") return true;
			return false; // Allow resubscribe or switch
		}

		// Normal flow: disable current plan
		if (currentPlan === plan.id) return true;
		return false;
	};

	return (
		<div className="min-h-screen bg-background">
			{/* Navigation */}
			<nav className="border-b border-border">
				<div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						<button
							type="button"
							onClick={() => navigate("/")}
							className="text-xl font-bold hover:opacity-80 transition-opacity"
						>
							jack-template
						</button>
						<div className="flex items-center gap-4">
							<ThemeToggle />
							{isLoggedIn ? (
								<Button onClick={() => navigate("/dashboard")}>Dashboard</Button>
							) : (
								<>
									<Button variant="ghost" onClick={() => navigate("/login")}>
										Log in
									</Button>
									<Button onClick={() => navigate("/signup")}>Get started</Button>
								</>
							)}
						</div>
					</div>
				</div>
			</nav>

			{/* Pricing Header */}
			<section className="py-16 px-4 sm:px-6 lg:px-8">
				<div className="max-w-4xl mx-auto text-center">
					<h1 className="text-4xl font-bold mb-4">Simple, transparent pricing</h1>
					<p className="text-lg text-muted-foreground">
						Choose the plan that's right for you. All plans include a 14-day free trial.
					</p>
					{isLoggedIn && currentPlan !== "free" && (
						<div className="mt-4">
							<Button variant="outline" size="sm" asChild>
								<a href="/api/billing-portal">Manage Billing in Stripe</a>
							</Button>
						</div>
					)}
				</div>
			</section>

			{/* Test Mode Banner - only shown when Stripe is in test mode */}
			{stripeTestMode && (
				<div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-8">
					<div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
						<p className="text-sm text-yellow-800 dark:text-yellow-200">
							<strong>Test Mode:</strong> Use card{" "}
							<code className="bg-yellow-100 dark:bg-yellow-800 px-1 rounded">
								4242 4242 4242 4242
							</code>{" "}
							with any future expiry and CVC.
						</p>
					</div>
				</div>
			)}

			{/* Cancellation Pending Notice */}
			{isCancelling && (
				<div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-8">
					<div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
						<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
							<p className="text-sm text-yellow-800 dark:text-yellow-200">
								<strong>Your subscription is set to cancel.</strong> You'll have access to{" "}
								{getPlanName(currentPlan || "free")} features until{" "}
								{periodEnd ? new Date(periodEnd).toLocaleDateString() : "the end of your billing period"}.
							</p>
							<Button variant="outline" size="sm" asChild className="shrink-0">
								<a href="/api/billing-portal">Manage in Stripe</a>
							</Button>
						</div>
					</div>
				</div>
			)}

			{/* Error Message */}
			{error && (
				<div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mb-8">
					<div className="p-4 bg-destructive/10 border border-destructive/20 rounded-md">
						<p className="text-sm text-destructive text-center">{error}</p>
					</div>
				</div>
			)}

			{/* Pricing Cards */}
			<section className="pb-20 px-4 sm:px-6 lg:px-8">
				<div className="max-w-6xl mx-auto">
					<div className="grid md:grid-cols-3 gap-8">
						{plans.map((plan) => (
							<Card
								key={plan.id}
								className={plan.highlighted ? "border-2 border-primary shadow-lg" : ""}
							>
								<CardHeader>
									{plan.highlighted && (
										<div className="text-xs font-semibold text-primary uppercase tracking-wide mb-2">
											Most popular
										</div>
									)}
									<CardTitle className="text-2xl">{plan.name}</CardTitle>
									<div className="mt-2">
										<span className="text-4xl font-bold">{plan.price}</span>
										{plan.id !== "free" && (
											<span className="text-muted-foreground">/month</span>
										)}
									</div>
									<CardDescription className="mt-2">{plan.description}</CardDescription>
								</CardHeader>
								<CardContent>
									<ul className="space-y-3">
										{plan.features.map((feature) => (
											<li key={feature} className="flex items-start gap-3">
												<svg
													className="w-5 h-5 text-primary flex-shrink-0 mt-0.5"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
												>
													<path
														strokeLinecap="round"
														strokeLinejoin="round"
														strokeWidth={2}
														d="M5 13l4 4L19 7"
													/>
												</svg>
												<span className="text-sm">{feature}</span>
											</li>
										))}
									</ul>
								</CardContent>
								<CardFooter>
									<Button
										className="w-full"
										variant={plan.highlighted ? "default" : "outline"}
										onClick={() => handleUpgrade(plan.id)}
										disabled={isButtonDisabled(plan)}
									>
										{upgradeLoading === plan.id ? (
											<>
												<svg
													className="animate-spin -ml-1 mr-2 h-4 w-4"
													fill="none"
													viewBox="0 0 24 24"
												>
													<circle
														className="opacity-25"
														cx="12"
														cy="12"
														r="10"
														stroke="currentColor"
														strokeWidth="4"
													/>
													<path
														className="opacity-75"
														fill="currentColor"
														d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
													/>
												</svg>
												Processing...
											</>
										) : isLoading ? (
											<div className="h-5 w-20 bg-muted animate-pulse rounded" />
										) : (
											getButtonText(plan)
										)}
									</Button>
								</CardFooter>
							</Card>
						))}
					</div>
				</div>
			</section>

			{/* FAQ Section */}
			<section className="py-16 px-4 sm:px-6 lg:px-8 bg-muted/50">
				<div className="max-w-4xl mx-auto">
					<h2 className="text-2xl font-bold text-center mb-12">Frequently asked questions</h2>
					<div className="grid md:grid-cols-2 gap-8">
						<div>
							<h3 className="font-semibold mb-2">Can I change plans later?</h3>
							<p className="text-sm text-muted-foreground">
								Yes, you can upgrade or downgrade your plan at any time. Changes take effect
								immediately.
							</p>
						</div>
						<div>
							<h3 className="font-semibold mb-2">What payment methods do you accept?</h3>
							<p className="text-sm text-muted-foreground">
								We accept all major credit cards through our secure Stripe integration.
							</p>
						</div>
						<div>
							<h3 className="font-semibold mb-2">Is there a free trial?</h3>
							<p className="text-sm text-muted-foreground">
								Yes, all paid plans come with a 14-day free trial. No credit card required to start.
							</p>
						</div>
						<div>
							<h3 className="font-semibold mb-2">Can I cancel anytime?</h3>
							<p className="text-sm text-muted-foreground">
								Absolutely. You can cancel your subscription at any time with no questions asked.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t border-border py-12 px-4 sm:px-6 lg:px-8">
				<div className="max-w-6xl mx-auto">
					<div className="flex flex-col md:flex-row justify-between items-center gap-6">
						<div className="flex items-center gap-2">
							<span className="font-bold">jack-template</span>
							<span className="text-muted-foreground text-sm">Built with Jack</span>
						</div>
						<div className="flex gap-6">
							<button
								type="button"
								onClick={() => navigate("/")}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors"
							>
								Home
							</button>
							<button
								type="button"
								onClick={() => navigate("/login")}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors"
							>
								Log in
							</button>
							<button
								type="button"
								onClick={() => navigate("/signup")}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors"
							>
								Sign up
							</button>
						</div>
					</div>
					<div className="mt-8 pt-8 border-t border-border text-center text-sm text-muted-foreground">
						&copy; {new Date().getFullYear()} jack-template. All rights reserved.
					</div>
				</div>
			</footer>
		</div>
	);
}
