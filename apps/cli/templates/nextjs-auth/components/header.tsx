import { Shield } from "lucide-react";
import Link from "next/link";

interface HeaderProps {
	user?: {
		name: string | null;
		email: string;
	};
}

export function Header({ user }: HeaderProps) {
	return (
		<header className="border-b border-gray-200 bg-white">
			<div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
				<Link href="/" className="flex items-center gap-2 font-semibold">
					<div className="flex size-7 items-center justify-center rounded-md bg-gray-900 text-white text-xs">
						<Shield className="size-4" />
					</div>
					jack-template
				</Link>

				<nav className="flex items-center gap-1">
					{user ? (
						<Link
							href="/dashboard"
							className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
						>
							Dashboard
						</Link>
					) : (
						<>
							<Link
								href="/login"
								className="rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-100 hover:text-gray-900"
							>
								Sign In
							</Link>
							<Link
								href="/signup"
								className="rounded-md bg-gray-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-gray-800"
							>
								Sign Up
							</Link>
						</>
					)}
				</nav>
			</div>
		</header>
	);
}
