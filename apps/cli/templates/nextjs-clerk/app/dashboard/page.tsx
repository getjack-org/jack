import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
	const user = await currentUser();

	if (!user) {
		redirect("/sign-in");
	}

	return (
		<main className="mx-auto max-w-3xl px-6 py-12">
			<h1 className="text-2xl font-bold">Dashboard</h1>
			<p className="mt-1 text-gray-500">Welcome back. This page is protected by Clerk middleware.</p>

			<div className="mt-8 rounded-xl border border-gray-200 bg-white p-6">
				<h2 className="text-lg font-semibold">Your Profile</h2>
				<dl className="mt-4 space-y-3">
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-sm font-medium text-gray-500">Name</dt>
						<dd className="text-sm">
							{user.firstName} {user.lastName}
						</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-sm font-medium text-gray-500">Email</dt>
						<dd className="text-sm">{user.emailAddresses[0]?.emailAddress}</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-sm font-medium text-gray-500">User ID</dt>
						<dd className="text-sm font-mono text-gray-400">{user.id}</dd>
					</div>
					<div className="flex gap-2">
						<dt className="w-28 shrink-0 text-sm font-medium text-gray-500">Joined</dt>
						<dd className="text-sm">
							{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "Unknown"}
						</dd>
					</div>
				</dl>
			</div>

			<div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
				<h2 className="text-lg font-semibold">Next Steps</h2>
				<ul className="mt-3 space-y-2 text-sm text-gray-600">
					<li>
						Add social providers in the{" "}
						<a
							href="https://dashboard.clerk.com"
							target="_blank"
							rel="noopener noreferrer"
							className="font-medium text-gray-900 underline underline-offset-2"
						>
							Clerk dashboard
						</a>
					</li>
					<li>Protect more routes by editing <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">middleware.ts</code></li>
					<li>
						Access user data in server components with{" "}
						<code className="rounded bg-gray-100 px-1 py-0.5 text-xs">currentUser()</code>
					</li>
					<li>
						Access auth state in client components with{" "}
						<code className="rounded bg-gray-100 px-1 py-0.5 text-xs">useUser()</code>
					</li>
				</ul>
			</div>
		</main>
	);
}
