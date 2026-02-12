"use client";

import { authClient } from "@/lib/auth-client";
import { Check, Eye, EyeOff, Loader2, Mail } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

interface AuthFormProps {
	mode: "login" | "signup";
}

export function AuthForm({ mode }: AuthFormProps) {
	const searchParams = useSearchParams();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [success, setSuccess] = useState(false);

	const isLogin = mode === "login";
	const rawCallback = isLogin ? searchParams.get("callbackUrl") : null;
	const callbackUrl =
		rawCallback?.startsWith("/") && !rawCallback.startsWith("//") ? rawCallback : "/dashboard";
	const title = isLogin ? "Sign in to your account" : "Create your account";
	const submitLabel = isLogin ? "Sign In" : "Sign Up";
	const switchText = isLogin ? "Don't have an account?" : "Already have an account?";
	const switchHref = isLogin ? "/signup" : "/login";
	const switchLabel = isLogin ? "Sign up" : "Sign in";

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			if (isLogin) {
				const result = await authClient.signIn.email({
					email,
					password,
				});

				if (result.error) {
					setError(result.error.message || "Invalid email or password");
					return;
				}

				// Full reload ensures middleware + server components re-evaluate with new auth state
				window.location.href = callbackUrl;
			} else {
				const result = await authClient.signUp.email({
					email,
					password,
					name: name || email.split("@")[0],
				});

				if (result.error) {
					setError(result.error.message || "Failed to create account");
					return;
				}

				setSuccess(true);
				setTimeout(() => {
					window.location.href = "/dashboard";
				}, 800);
				return;
			}
		} catch {
			setError("Something went wrong. Please try again.");
		} finally {
			setLoading(false);
		}
	}

	if (success) {
		return (
			<div className="flex min-h-screen items-center justify-center px-4">
				<div className="w-full max-w-sm text-center">
					<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-green-100">
						<Check className="size-6 text-green-600" />
					</div>
					<h1 className="text-xl font-bold">Account created!</h1>
					<p className="mt-2 text-sm text-gray-500">Redirecting to your dashboard...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm">
				<div className="mb-8 text-center">
					<Link
						href="/"
						className="mb-6 inline-flex items-center gap-2 text-sm text-gray-500 transition hover:text-gray-700"
					>
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold">{title}</h1>
				</div>

				<form onSubmit={handleSubmit} className="space-y-4">
					{!isLogin && (
						<div>
							<label htmlFor="name" className="mb-1.5 block text-sm font-medium text-gray-700">
								Name
							</label>
							<input
								id="name"
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Your name"
								className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
							/>
						</div>
					)}

					<div>
						<label htmlFor="email" className="mb-1.5 block text-sm font-medium text-gray-700">
							Email
						</label>
						<input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="you@example.com"
							required
							className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
						/>
					</div>

					<div>
						<label htmlFor="password" className="mb-1.5 block text-sm font-medium text-gray-700">
							Password
						</label>
						<div className="relative">
							<input
								id="password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="Enter your password"
								required
								minLength={8}
								className="w-full rounded-lg border border-gray-300 px-3 py-2 pr-9 text-sm outline-none transition focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
							/>
							<button
								type="button"
								onClick={() => setShowPassword(!showPassword)}
								className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
								tabIndex={-1}
							>
								{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
							</button>
						</div>
					</div>

					{error && (
						<div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
							{error}
						</div>
					)}

					<button
						type="submit"
						disabled={loading}
						className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{loading ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
						{submitLabel}
					</button>
				</form>

				{/* Social login (GitHub, Google) is pre-wired in lib/auth.ts.
				    To enable: add GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET or
				    GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET via `jack secrets` */}

				<p className="mt-6 text-center text-sm text-gray-500">
					{switchText}{" "}
					<Link href={switchHref} className="font-medium text-gray-900 hover:underline">
						{switchLabel}
					</Link>
				</p>
			</div>
		</div>
	);
}
