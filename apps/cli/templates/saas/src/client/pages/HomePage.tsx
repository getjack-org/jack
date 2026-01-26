import { useEffect, useState } from "react";
import { ThemeToggle } from "../components/ThemeToggle";
import { authClient } from "../lib/auth-client";

interface HomePageProps {
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

export default function HomePage({ navigate }: HomePageProps) {
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		authClient.getSession().then((result) => {
			setIsLoggedIn(!!result.data?.user);
			setIsLoading(false);
		});
	}, []);

	return (
		<div className="min-h-screen bg-background">
			{/* Navigation */}
			<nav className="border-b border-border">
				<div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
					<div className="flex justify-between items-center h-16">
						<div className="flex items-center">
							<span className="text-xl font-bold">jack-template</span>
						</div>
						<div className="flex items-center gap-4">
							<button
								type="button"
								onClick={() => navigate("/pricing")}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors"
							>
								Pricing
							</button>
							<ThemeToggle />
							{!isLoading && !isLoggedIn && (
								<button
									type="button"
									onClick={() => navigate("/login")}
									className="text-sm text-muted-foreground hover:text-foreground transition-colors"
								>
									Log in
								</button>
							)}
							<button
								type="button"
								onClick={() => navigate(isLoggedIn ? "/dashboard" : "/signup")}
								className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity text-sm font-medium min-w-[100px]"
							>
								{isLoggedIn ? "Dashboard" : "Get started"}
							</button>
						</div>
					</div>
				</div>
			</nav>

			{/* Hero Section */}
			<section className="py-20 px-4 sm:px-6 lg:px-8">
				<div className="max-w-4xl mx-auto text-center">
					<h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
						Build your SaaS faster than ever
					</h1>
					<p className="text-lg sm:text-xl text-muted-foreground mb-10 max-w-2xl mx-auto">
						A production-ready template with authentication, payments, and everything you need to
						launch your next project in minutes, not months.
					</p>
					<div className="flex flex-col sm:flex-row gap-4 justify-center">
						<button
							type="button"
							onClick={() => navigate(isLoggedIn ? "/dashboard" : "/signup")}
							className="px-8 py-3 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity text-base font-medium min-w-[160px]"
						>
							{isLoggedIn ? "Go to Dashboard" : "Start for free"}
						</button>
						<button
							type="button"
							onClick={() => navigate("/pricing")}
							className="px-8 py-3 border border-border rounded-md hover:bg-accent transition-colors text-base font-medium"
						>
							View pricing
						</button>
					</div>
				</div>
			</section>

			{/* Features Section */}
			<section className="py-20 px-4 sm:px-6 lg:px-8 bg-muted/50">
				<div className="max-w-6xl mx-auto">
					<div className="text-center mb-16">
						<h2 className="text-3xl font-bold mb-4">Everything you need to ship</h2>
						<p className="text-muted-foreground max-w-2xl mx-auto">
							Focus on building your product, not reinventing authentication, payments, or
							infrastructure.
						</p>
					</div>
					<div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
						{/* Feature 1 */}
						<div className="p-6 bg-card rounded-lg border border-border">
							<div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
								<svg
									className="w-6 h-6 text-primary"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
									/>
								</svg>
							</div>
							<h3 className="font-semibold mb-2">Authentication</h3>
							<p className="text-sm text-muted-foreground">
								Secure email/password auth with sessions, powered by Better Auth.
							</p>
						</div>

						{/* Feature 2 */}
						<div className="p-6 bg-card rounded-lg border border-border">
							<div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
								<svg
									className="w-6 h-6 text-primary"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
									/>
								</svg>
							</div>
							<h3 className="font-semibold mb-2">Payments</h3>
							<p className="text-sm text-muted-foreground">
								Stripe integration for subscriptions, one-time payments, and billing.
							</p>
						</div>

						{/* Feature 3 */}
						<div className="p-6 bg-card rounded-lg border border-border">
							<div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
								<svg
									className="w-6 h-6 text-primary"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
									/>
								</svg>
							</div>
							<h3 className="font-semibold mb-2">Database</h3>
							<p className="text-sm text-muted-foreground">
								Cloudflare D1 database with Drizzle ORM for type-safe queries.
							</p>
						</div>

						{/* Feature 4 */}
						<div className="p-6 bg-card rounded-lg border border-border">
							<div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
								<svg
									className="w-6 h-6 text-primary"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M13 10V3L4 14h7v7l9-11h-7z"
									/>
								</svg>
							</div>
							<h3 className="font-semibold mb-2">Edge Deployment</h3>
							<p className="text-sm text-muted-foreground">
								Deploy globally on Cloudflare Workers for blazing fast performance.
							</p>
						</div>
					</div>
				</div>
			</section>

			{/* Pricing Preview Section */}
			<section className="py-20 px-4 sm:px-6 lg:px-8">
				<div className="max-w-4xl mx-auto text-center">
					<h2 className="text-3xl font-bold mb-4">Simple, transparent pricing</h2>
					<p className="text-muted-foreground mb-10">
						Start free and upgrade as you grow. No hidden fees, no surprises.
					</p>
					<div className="flex flex-col sm:flex-row gap-6 justify-center items-center">
						<div className="p-6 bg-card rounded-lg border border-border text-left w-full sm:w-64">
							<h3 className="font-semibold mb-1">Free</h3>
							<p className="text-2xl font-bold mb-2">
								$0<span className="text-sm font-normal text-muted-foreground">/mo</span>
							</p>
							<p className="text-sm text-muted-foreground">Perfect for getting started</p>
						</div>
						<div className="p-6 bg-card rounded-lg border-2 border-primary text-left w-full sm:w-64">
							<h3 className="font-semibold mb-1">Pro</h3>
							<p className="text-2xl font-bold mb-2">
								$19<span className="text-sm font-normal text-muted-foreground">/mo</span>
							</p>
							<p className="text-sm text-muted-foreground">For growing businesses</p>
						</div>
						<div className="p-6 bg-card rounded-lg border border-border text-left w-full sm:w-64">
							<h3 className="font-semibold mb-1">Enterprise</h3>
							<p className="text-2xl font-bold mb-2">
								$99<span className="text-sm font-normal text-muted-foreground">/mo</span>
							</p>
							<p className="text-sm text-muted-foreground">For large scale operations</p>
						</div>
					</div>
					<button
						type="button"
						onClick={() => navigate("/pricing")}
						className="mt-8 text-sm text-primary hover:underline"
					>
						See full pricing details
					</button>
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
								onClick={() => navigate("/pricing")}
								className="text-sm text-muted-foreground hover:text-foreground transition-colors"
							>
								Pricing
							</button>
							{isLoggedIn ? (
								<button
									type="button"
									onClick={() => navigate("/dashboard")}
									className="text-sm text-muted-foreground hover:text-foreground transition-colors"
								>
									Dashboard
								</button>
							) : (
								<>
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
								</>
							)}
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
