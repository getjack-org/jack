import { Header } from "@/components/header";
import { UserMenu } from "@/components/user-menu";
import { getAuth } from "@/lib/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
	const auth = await getAuth();
	const session = await auth.api.getSession({
		headers: await headers(),
	});

	if (!session) {
		redirect("/login");
	}

	return (
		<div className="min-h-screen">
			<Header user={session.user} />

			<main className="mx-auto max-w-3xl px-6 py-12">
				<div className="mb-8">
					<h1 className="text-2xl font-bold">Dashboard</h1>
					<p className="mt-1 text-gray-500">
						Welcome back, {session.user.name || session.user.email}
					</p>
				</div>

				<div className="grid gap-6 sm:grid-cols-2">
					<div className="rounded-xl border border-gray-200 bg-white p-6">
						<h2 className="font-semibold">Profile</h2>
						<div className="mt-4 space-y-3">
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-gray-400">Name</p>
								<p className="mt-0.5">{session.user.name || "Not set"}</p>
							</div>
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-gray-400">Email</p>
								<p className="mt-0.5">{session.user.email}</p>
							</div>
						</div>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6">
						<h2 className="font-semibold">Session</h2>
						<div className="mt-4 space-y-3">
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-gray-400">
									Session ID
								</p>
								<p className="mt-0.5 truncate font-mono text-sm text-gray-600">
									{session.session.id}
								</p>
							</div>
							<div>
								<p className="text-xs font-medium uppercase tracking-wide text-gray-400">Expires</p>
								<p className="mt-0.5 text-sm text-gray-600">
									{new Date(session.session.expiresAt).toLocaleString()}
								</p>
							</div>
						</div>
					</div>
				</div>

				<div className="mt-8">
					<UserMenu />
				</div>
			</main>
		</div>
	);
}
