import { useState } from "react";
import { authClient } from "../lib/auth-client";
import { ThemeToggle } from "../components/ThemeToggle";

interface LoginPageProps {
	navigate: (route: "/" | "/login" | "/signup" | "/pricing" | "/dashboard" | "/forgot-password" | "/reset-password") => void;
}

export default function LoginPage({ navigate }: LoginPageProps) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setIsLoading(true);

		try {
			const result = await authClient.signIn.email({
				email,
				password,
			});

			if (result.error) {
				setError(result.error.message || "Failed to sign in. Please check your credentials.");
				setIsLoading(false);
				return;
			}

			navigate("/dashboard");
		} catch (err) {
			setError("An unexpected error occurred. Please try again.");
			setIsLoading(false);
		}
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

			{/* Login Form */}
			<div className="flex-1 flex items-center justify-center px-4 py-12">
				<div className="w-full max-w-md">
					<div className="text-center mb-8">
						<h1 className="text-2xl font-bold mb-2">Welcome back</h1>
						<p className="text-muted-foreground">Sign in to your account to continue</p>
					</div>

					<form onSubmit={handleSubmit} className="space-y-4">
						{error && (
							<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
								<p className="text-sm text-destructive">{error}</p>
							</div>
						)}

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
								disabled={isLoading}
								className="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
							/>
						</div>

						<div>
							<div className="flex items-center justify-between mb-2">
								<label htmlFor="password" className="text-sm font-medium">
									Password
								</label>
								<button
									type="button"
									onClick={() => navigate("/forgot-password")}
									className="text-sm text-primary hover:underline"
								>
									Forgot password?
								</button>
							</div>
							<input
								id="password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="Enter your password"
								required
								disabled={isLoading}
								className="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
							/>
						</div>

						<button
							type="submit"
							disabled={isLoading}
							className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
						>
							{isLoading ? (
								<>
									<svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
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
									Signing in...
								</>
							) : (
								"Sign in"
							)}
						</button>
					</form>

					<div className="mt-6 text-center">
						<p className="text-sm text-muted-foreground">
							Don't have an account?{" "}
							<button
								type="button"
								onClick={() => navigate("/signup")}
								className="text-primary hover:underline font-medium"
							>
								Sign up
							</button>
						</p>
					</div>

					<div className="mt-4 text-center">
						<button
							type="button"
							onClick={() => navigate("/")}
							className="text-sm text-muted-foreground hover:text-foreground transition-colors"
						>
							Back to home
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
