import { SignInButton, SignedIn, SignedOut } from "@clerk/nextjs";
import { ArrowRight, LogIn, Shield, Zap } from "lucide-react";
import Link from "next/link";

export default function Home() {
	return (
		<main className="mx-auto max-w-4xl px-6 py-16">
			<section className="text-center">
				<p className="mb-4 inline-block rounded-full bg-gray-100 px-4 py-1.5 text-sm font-medium text-gray-600">
					Next.js + Clerk Auth
				</p>
				<h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
					Authentication
					<br />
					<span className="text-gray-400">ready in seconds</span>
				</h1>
				<p className="mt-4 text-lg text-gray-500">
					Managed auth with Clerk. Sign-in, sign-up, and route protection out of the box.
				</p>
				<div className="mt-8 flex items-center justify-center gap-3">
					<SignedOut>
						<SignInButton mode="modal">
							<button
								type="button"
								className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
							>
								Sign In
								<LogIn className="size-4" />
							</button>
						</SignInButton>
					</SignedOut>
					<SignedIn>
						<Link
							href="/dashboard"
							className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-800"
						>
							Go to Dashboard
							<ArrowRight className="size-4" />
						</Link>
					</SignedIn>
				</div>
			</section>

			<hr className="my-16 border-gray-200" />

			<section className="grid gap-6 sm:grid-cols-3">
				<div className="rounded-xl border border-gray-200 bg-white p-6">
					<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
						<LogIn className="size-5 text-gray-700" />
					</div>
					<h3 className="font-semibold">Pre-built Auth Pages</h3>
					<p className="mt-1 text-sm text-gray-500">
						Sign-in and sign-up pages with Clerk components. Social providers configurable in the Clerk dashboard.
					</p>
				</div>

				<div className="rounded-xl border border-gray-200 bg-white p-6">
					<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
						<Shield className="size-5 text-gray-700" />
					</div>
					<h3 className="font-semibold">Route Protection</h3>
					<p className="mt-1 text-sm text-gray-500">
						Middleware-based route protection. The dashboard is protected by default. Add more routes easily.
					</p>
				</div>

				<div className="rounded-xl border border-gray-200 bg-white p-6">
					<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
						<Zap className="size-5 text-gray-700" />
					</div>
					<h3 className="font-semibold">Edge SSR</h3>
					<p className="mt-1 text-sm text-gray-500">
						Server-rendered globally via OpenNext. Fast auth checks at the edge with no cold starts.
					</p>
				</div>
			</section>

			<footer className="mt-16 border-t border-gray-200 pt-6">
				<p className="text-center text-sm text-gray-400">
					Built with jack. Ship it with{" "}
					<code className="rounded bg-gray-100 px-1 py-0.5 text-gray-600">jack ship</code>
				</p>
			</footer>
		</main>
	);
}
