import { Header } from "@/components/header";
import { LogIn, Shield, UserPlus } from "lucide-react";
import Link from "next/link";

export default function Home() {
	return (
		<div className="min-h-screen">
			<Header />

			<main className="mx-auto max-w-3xl px-6 py-20 text-center">
				<div className="mb-6 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600">
					<Shield className="size-4" />
					Self-hosted authentication
				</div>

				<h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
					Authentication
					<br />
					<span className="text-gray-400">ready to go</span>
				</h1>

				<p className="mx-auto mt-4 max-w-lg text-lg text-gray-500">
					Email/password login, session management, and optional social login. Your auth data stays
					in your database.
				</p>

				<div className="mt-10 flex items-center justify-center gap-4">
					<Link
						href="/signup"
						className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
					>
						<UserPlus className="size-4" />
						Sign Up
					</Link>
					<Link
						href="/login"
						className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
					>
						<LogIn className="size-4" />
						Sign In
					</Link>
				</div>

				<div className="mt-20 grid gap-6 sm:grid-cols-3">
					<div className="rounded-xl border border-gray-200 bg-white p-6 text-left">
						<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
							<Shield className="size-5 text-gray-600" />
						</div>
						<h3 className="font-semibold">Self-hosted</h3>
						<p className="mt-1 text-sm text-gray-500">
							Your auth data lives in your D1 database. No third-party dependency.
						</p>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 text-left">
						<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
							<LogIn className="size-5 text-gray-600" />
						</div>
						<h3 className="font-semibold">Email + Social</h3>
						<p className="mt-1 text-sm text-gray-500">
							Email/password out of the box. Add GitHub or Google OAuth with two environment
							variables.
						</p>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 text-left">
						<div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-gray-100">
							<UserPlus className="size-5 text-gray-600" />
						</div>
						<h3 className="font-semibold">Extensible</h3>
						<p className="mt-1 text-sm text-gray-500">
							Add 2FA, magic links, passkeys, and organizations via Better Auth plugins.
						</p>
					</div>
				</div>
			</main>

			<footer className="border-t border-gray-200 py-6">
				<p className="text-center text-sm text-gray-400">
					Built with jack. Deploy with{" "}
					<code className="rounded bg-gray-100 px-1 py-0.5 text-gray-600">jack ship</code>
				</p>
			</footer>
		</div>
	);
}
