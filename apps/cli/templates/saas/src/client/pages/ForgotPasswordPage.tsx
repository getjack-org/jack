import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { toast } from "sonner";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";

interface ForgotPasswordPageProps {
	navigate: (route: "/" | "/login" | "/signup" | "/pricing" | "/dashboard" | "/forgot-password" | "/reset-password") => void;
}

export default function ForgotPasswordPage({ navigate }: ForgotPasswordPageProps) {
	const [email, setEmail] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [submitted, setSubmitted] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);

		try {
			const result = await authClient.requestPasswordReset({
				email,
				redirectTo: `${window.location.origin}/#/reset-password`,
			});

			if (result.error) {
				toast.error("Failed to send reset email", {
					description: result.error.message || "Please try again.",
				});
				setIsLoading(false);
				return;
			}

			setSubmitted(true);
			toast.success("Reset email sent", {
				description: "Check your inbox for the reset link.",
			});
		} catch (err) {
			toast.error("An unexpected error occurred");
		}

		setIsLoading(false);
	};

	return (
		<div className="min-h-screen bg-background flex flex-col">
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
						<ThemeToggle />
					</div>
				</div>
			</nav>

			{/* Form */}
			<div className="flex-1 flex items-center justify-center px-4 py-12">
				<div className="w-full max-w-md">
					<div className="text-center mb-8">
						<h1 className="text-2xl font-bold mb-2">Reset your password</h1>
						<p className="text-muted-foreground">
							{submitted
								? "Check your email for a reset link"
								: "Enter your email and we'll send you a reset link"}
						</p>
					</div>

					{submitted ? (
						<div className="space-y-4">
							<div className="p-4 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-lg text-center">
								<p className="text-green-800 dark:text-green-200">
									If an account exists for {email}, you'll receive an email with instructions.
								</p>
							</div>
							<Button
								type="button"
								variant="outline"
								className="w-full"
								onClick={() => navigate("/login")}
							>
								Back to login
							</Button>
						</div>
					) : (
						<form onSubmit={handleSubmit} className="space-y-4">
							<div>
								<label htmlFor="email" className="block text-sm font-medium mb-2">
									Email
								</label>
								<input
									id="email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder="you@example.com"
									required
									className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
								/>
							</div>

							<Button type="submit" className="w-full" disabled={isLoading}>
								{isLoading ? (
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
										Sending...
									</>
								) : (
									"Send reset link"
								)}
							</Button>

							<p className="text-center text-sm text-muted-foreground">
								Remember your password?{" "}
								<button
									type="button"
									onClick={() => navigate("/login")}
									className="text-primary hover:underline"
								>
									Sign in
								</button>
							</p>
						</form>
					)}
				</div>
			</div>
		</div>
	);
}
