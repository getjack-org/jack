"use client";

import { authClient } from "@/lib/auth-client";
import { LogOut } from "lucide-react";

export function UserMenu() {
	async function handleSignOut() {
		await authClient.signOut();
		// Full reload after auth state change ensures middleware + server components re-evaluate
		window.location.href = "/";
	}

	return (
		<button
			type="button"
			onClick={handleSignOut}
			className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
		>
			<LogOut className="size-4" />
			Sign Out
		</button>
	);
}
