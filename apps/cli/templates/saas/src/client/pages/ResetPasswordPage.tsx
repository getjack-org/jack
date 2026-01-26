import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ThemeToggle } from "../components/ThemeToggle";
import { Button } from "../components/ui/button";
import { authClient } from "../lib/auth-client";

interface ResetPasswordPageProps {
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

export default function ResetPasswordPage({ navigate }: ResetPasswordPageProps) {
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [token, setToken] = useState<string | null>(null);

	useEffect(() => {
		// Extract token from URL - Better Auth adds it as a query param
		const hash = window.location.hash;
		const searchParams = new URLSearchParams(hash.split("?")[1] || "");
		const tokenParam = searchParams.get("token");
		setToken(tokenParam);
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);

		if (password.length < 8) {
			setError("Password must be at least 8 characters long.");
			return;
		}

		if (password !== confirmPassword) {
			setError("Passwords do not match.");
			return;
		}

		if (!token) {
			setError("Invalid or missing reset token. Please request a new reset link.");
			return;
		}

		setIsLoading(true);

		try {
			const result = await authClient.resetPassword({
				newPassword: password,
				token,
			});

			if (result.error) {
				setError(result.error.message || "Failed to reset password. The link may have expired.");
				setIsLoading(false);
				return;
			}

			toast.success("Password reset successfully", {
				description: "You can now sign in with your new password.",
			});
			navigate("/login");
		} catch (err) {
			setError("An unexpected error occurred. Please try again.");
		}

		setIsLoading(false);
	};

	if (!token) {
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

				<div className="flex-1 flex items-center justify-center px-4 py-12">
					<div className="w-full max-w-md text-center">
						<h1 className="text-2xl font-bold mb-4">Invalid Reset Link</h1>
						<p className="text-muted-foreground mb-6">
							This password reset link is invalid or has expired. Please request a new one.
						</p>
						<Button onClick={() => navigate("/forgot-password")}>Request new reset link</Button>
					</div>
				</div>
			</div>
		);
	}

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
						<h1 className="text-2xl font-bold mb-2">Set new password</h1>
						<p className="text-muted-foreground">Enter your new password below</p>
					</div>

					<form onSubmit={handleSubmit} className="space-y-4">
						{error && (
							<div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
								<p className="text-sm text-destructive">{error}</p>
							</div>
						)}

						<div>
							<label htmlFor="password" className="block text-sm font-medium mb-2">
								New Password
							</label>
							<input
								id="password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="Enter new password"
								required
								className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
							/>
						</div>

						<div>
							<label htmlFor="confirmPassword" className="block text-sm font-medium mb-2">
								Confirm Password
							</label>
							<input
								id="confirmPassword"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								placeholder="Confirm new password"
								required
								className="w-full px-3 py-2 border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
							/>
						</div>

						<Button type="submit" className="w-full" disabled={isLoading}>
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
									Resetting...
								</>
							) : (
								"Reset password"
							)}
						</Button>
					</form>
				</div>
			</div>
		</div>
	);
}
