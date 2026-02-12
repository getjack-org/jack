"use client";

import { SignInButton, SignedIn, SignedOut, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function Header() {
	return (
		<header className="border-b border-gray-200 bg-white">
			<div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-6">
				<Link href="/" className="flex items-center gap-2 font-semibold">
					<div className="flex size-7 items-center justify-center rounded-md bg-gray-900 text-xs text-white">
						J
					</div>
					jack-template
				</Link>
				<nav className="flex items-center gap-3">
					<SignedIn>
						<Link
							href="/dashboard"
							className="text-sm text-gray-600 hover:text-gray-900"
						>
							Dashboard
						</Link>
						<UserButton />
					</SignedIn>
					<SignedOut>
						<SignInButton mode="modal">
							<button
								type="button"
								className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800"
							>
								Sign In
							</button>
						</SignInButton>
					</SignedOut>
				</nav>
			</div>
		</header>
	);
}
