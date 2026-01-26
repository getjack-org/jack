import { useEffect, useState } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useAuth } from "../hooks/useAuth";
import { useSubscription } from "../hooks/useSubscription";
import { getPlanName } from "../lib/plans";

interface DashboardPageProps {
	navigate: (
		route:
			| "/"
			| "/login"
			| "/signup"
			| "/pricing"
			| "/dashboard"
			| "/forgot-password"
			| "/reset-password",
	) => void;
}

export default function DashboardPage({ navigate }: DashboardPageProps) {
	const { user, signOut } = useAuth();
	const {
		plan,
		isSubscribed,
		isCancelling,
		periodEnd,
		isLoading: isSubscriptionLoading,
	} = useSubscription();
	const [showUpgradeSuccess, setShowUpgradeSuccess] = useState(false);

	// Check for upgrade success
	useEffect(() => {
		const hash = window.location.hash;
		if (hash.includes("upgraded=true")) {
			setShowUpgradeSuccess(true);
			// Clean up URL
			window.history.replaceState(null, "", window.location.pathname + "#/dashboard");
		}
	}, []);

	const handleSignOut = async () => {
		await signOut();
		navigate("/");
	};

	const getPlanBadgeClasses = (planName: string) => {
		switch (planName) {
			case "pro":
				return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
			case "enterprise":
				return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200";
			default:
				return "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200";
		}
	};

	// Stats based on plan
	const getStats = () => {
		const currentPlan = isSubscribed ? plan : "free";
		switch (currentPlan) {
			case "enterprise":
				return {
					apiCalls: { value: "Unlimited", limit: null },
					projects: { value: "42", limit: "Unlimited" },
					teamMembers: { value: "18", limit: "Unlimited" },
				};
			case "pro":
				return {
					apiCalls: { value: "8,234", limit: "50,000" },
					projects: { value: "7", limit: "Unlimited" },
					teamMembers: { value: "5", limit: "10" },
				};
			default:
				return {
					apiCalls: { value: "847", limit: "1,000" },
					projects: { value: "1", limit: "1" },
					teamMembers: { value: "1", limit: "1" },
				};
		}
	};

	const stats = getStats();
	const currentPlan = isSubscribed ? plan : "free";

	return (
		<div className="min-h-screen bg-background">
			{/* Header */}
			<header className="border-b border-border">
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
							<span className="text-sm text-muted-foreground">{user?.email}</span>
							<ThemeToggle />
							<Button variant="ghost" size="sm" onClick={handleSignOut}>
								Sign out
							</Button>
						</div>
					</div>
				</div>
			</header>

			<main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				{/* Upgrade Success Celebration */}
				{showUpgradeSuccess && (
					<div className="mb-8 relative overflow-hidden rounded-xl bg-gradient-to-r from-green-500 to-emerald-600 p-6 text-white shadow-lg">
						<button
							type="button"
							onClick={() => setShowUpgradeSuccess(false)}
							className="absolute top-4 right-4 text-white/80 hover:text-white"
						>
							<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M6 18L18 6M6 6l12 12"
								/>
							</svg>
						</button>
						<div className="flex items-start gap-4">
							<div className="flex-shrink-0 w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
								<svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 13l4 4L19 7"
									/>
								</svg>
							</div>
							<div className="flex-1">
								<h2 className="text-xl font-bold mb-1">You're all set!</h2>
								<p className="text-white/90 mb-4">
									Your upgrade to{" "}
									<span className="font-semibold">
										{plan === "enterprise" ? "Enterprise" : "Pro"}
									</span>{" "}
									is complete. Here's what you just unlocked:
								</p>
								<div className="grid gap-2 sm:grid-cols-3 mb-4">
									<div className="bg-white/10 rounded-lg p-3">
										<div className="font-semibold">Unlimited Projects</div>
										<div className="text-sm text-white/80">Create as many as you need</div>
									</div>
									<div className="bg-white/10 rounded-lg p-3">
										<div className="font-semibold">Advanced Analytics</div>
										<div className="text-sm text-white/80">Deep insights into your data</div>
									</div>
									<div className="bg-white/10 rounded-lg p-3">
										<div className="font-semibold">Priority Support</div>
										<div className="text-sm text-white/80">Get help when you need it</div>
									</div>
								</div>
								<Button
									variant="secondary"
									className="bg-white text-green-700 hover:bg-white/90"
									onClick={() => setShowUpgradeSuccess(false)}
								>
									Start Using Pro Features
								</Button>
							</div>
						</div>
					</div>
				)}

				{/* Welcome Section */}
				<div className="mb-8">
					<h1 className="text-2xl font-bold mb-2">Welcome back, {user?.name || "there"}!</h1>
					<p className="text-muted-foreground">Here's what's happening with your account today.</p>
				</div>

				{/* Plan Status Card */}
				<Card className="mb-8">
					<CardHeader className="pb-3">
						<div className="flex items-center justify-between">
							<div>
								<CardTitle className="text-lg">Subscription Status</CardTitle>
								<CardDescription>Your current plan and usage</CardDescription>
							</div>
							{isSubscriptionLoading ? (
								<div className="h-6 w-16 bg-muted animate-pulse rounded-full" />
							) : (
								<div className="flex items-center gap-2">
									<span
										className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getPlanBadgeClasses(currentPlan)}`}
									>
										{getPlanName(currentPlan)}
									</span>
									{isCancelling && (
										<span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">
											Cancelling
										</span>
									)}
								</div>
							)}
						</div>
					</CardHeader>
					<CardContent>
						{isCancelling && (
							<div className="flex items-center justify-between p-4 mb-4 bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded-lg">
								<div>
									<p className="font-medium text-yellow-800 dark:text-yellow-200">
										Your subscription is set to cancel
									</p>
									<p className="text-sm text-yellow-700 dark:text-yellow-300">
										You'll have access to {getPlanName(currentPlan)} features until{" "}
										{periodEnd
											? new Date(periodEnd).toLocaleDateString()
											: "the end of your billing period"}
										.
									</p>
								</div>
								<Button variant="outline" onClick={() => navigate("/pricing")}>
									Resubscribe
								</Button>
							</div>
						)}
						{!isSubscribed && !isSubscriptionLoading && (
							<div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
								<div>
									<p className="font-medium">Upgrade to unlock more features</p>
									<p className="text-sm text-muted-foreground">
										Get unlimited projects, advanced analytics, and priority support.
									</p>
								</div>
								<Button onClick={() => navigate("/pricing")}>View Plans</Button>
							</div>
						)}
						{isSubscribed && currentPlan === "pro" && (
							<div className="flex items-center justify-between p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg">
								<div>
									<p className="font-medium">You're on the Pro plan</p>
									<p className="text-sm text-muted-foreground">
										Enjoying unlimited projects and advanced analytics.
									</p>
								</div>
								<div className="flex gap-2">
									<Button variant="outline" asChild>
										<a href="/api/billing-portal">Manage Billing</a>
									</Button>
									<Button variant="outline" onClick={() => navigate("/pricing")}>
										Upgrade
									</Button>
								</div>
							</div>
						)}
						{isSubscribed && currentPlan === "enterprise" && (
							<div className="flex items-center justify-between p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg">
								<div>
									<p className="font-medium">Enterprise plan active</p>
									<p className="text-sm text-muted-foreground">
										Full access to all features with dedicated support.
									</p>
								</div>
								<div className="flex gap-2">
									<Button variant="outline" asChild>
										<a href="/api/billing-portal">Manage Billing</a>
									</Button>
									<Button variant="outline" disabled>
										Contact Support
									</Button>
								</div>
							</div>
						)}
					</CardContent>
				</Card>

				{/* Stats Grid */}
				<div className="grid gap-4 md:grid-cols-3 mb-8">
					<Card>
						<CardHeader className="pb-2">
							<CardDescription>API Calls</CardDescription>
							<CardTitle className="text-3xl">{stats.apiCalls.value}</CardTitle>
						</CardHeader>
						<CardContent>
							{stats.apiCalls.limit && (
								<p className="text-xs text-muted-foreground">
									of {stats.apiCalls.limit} this month
								</p>
							)}
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="pb-2">
							<CardDescription>Projects</CardDescription>
							<CardTitle className="text-3xl">{stats.projects.value}</CardTitle>
						</CardHeader>
						<CardContent>
							<p className="text-xs text-muted-foreground">
								{stats.projects.limit === "Unlimited"
									? "Unlimited"
									: `of ${stats.projects.limit} available`}
							</p>
						</CardContent>
					</Card>
					<Card>
						<CardHeader className="pb-2">
							<CardDescription>Team Members</CardDescription>
							<CardTitle className="text-3xl">{stats.teamMembers.value}</CardTitle>
						</CardHeader>
						<CardContent>
							<p className="text-xs text-muted-foreground">
								{stats.teamMembers.limit === "Unlimited"
									? "Unlimited seats"
									: `of ${stats.teamMembers.limit} seats`}
							</p>
						</CardContent>
					</Card>
				</div>

				{/* Quick Actions */}
				<Card className="mb-8">
					<CardHeader>
						<CardTitle>Quick Actions</CardTitle>
						<CardDescription>Common tasks and shortcuts</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
							<Button variant="outline" className="h-auto py-4 flex flex-col items-center gap-2">
								<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M12 6v6m0 0v6m0-6h6m-6 0H6"
									/>
								</svg>
								<span>New Project</span>
							</Button>
							<Button variant="outline" className="h-auto py-4 flex flex-col items-center gap-2">
								<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
									/>
								</svg>
								<span>View Analytics</span>
							</Button>
							<Button variant="outline" className="h-auto py-4 flex flex-col items-center gap-2">
								<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
									/>
								</svg>
								<span>Invite Team</span>
							</Button>
							<Button variant="outline" className="h-auto py-4 flex flex-col items-center gap-2">
								<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
									/>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
									/>
								</svg>
								<span>Settings</span>
							</Button>
						</div>
					</CardContent>
				</Card>

				{/* Recent Activity */}
				<Card>
					<CardHeader>
						<CardTitle>Recent Activity</CardTitle>
						<CardDescription>Your latest actions and updates</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							<div className="flex items-center gap-4">
								<div className="w-2 h-2 bg-green-500 rounded-full" />
								<div className="flex-1">
									<p className="text-sm font-medium">Signed in successfully</p>
									<p className="text-xs text-muted-foreground">Just now</p>
								</div>
							</div>
							<div className="flex items-center gap-4">
								<div className="w-2 h-2 bg-blue-500 rounded-full" />
								<div className="flex-1">
									<p className="text-sm font-medium">Account created</p>
									<p className="text-xs text-muted-foreground">Welcome to the platform!</p>
								</div>
							</div>
							<div className="border-t pt-4">
								<p className="text-sm text-muted-foreground text-center">
									More activity will appear here as you use the app.
								</p>
							</div>
						</div>
					</CardContent>
				</Card>

				{/* Back to home link */}
				<div className="mt-8 text-center">
					<button
						type="button"
						onClick={() => navigate("/")}
						className="text-sm text-muted-foreground hover:text-foreground transition-colors"
					>
						Back to home
					</button>
				</div>
			</main>
		</div>
	);
}
