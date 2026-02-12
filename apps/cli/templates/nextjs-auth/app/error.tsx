"use client";

import { AlertCircle, RotateCcw } from "lucide-react";
import Link from "next/link";

// biome-ignore lint/suspicious/noShadowRestrictedNames: Next.js convention for error boundaries
export default function Error({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<div className="flex min-h-screen items-center justify-center px-4">
			<div className="w-full max-w-sm text-center">
				<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-red-100">
					<AlertCircle className="size-6 text-red-600" />
				</div>
				<h1 className="text-xl font-bold">Something went wrong</h1>
				<p className="mt-2 text-sm text-gray-500">
					{error.message || "An unexpected error occurred."}
				</p>
				{error.digest && <p className="mt-1 text-xs text-gray-400">Error ID: {error.digest}</p>}
				<div className="mt-6 flex items-center justify-center gap-3">
					<button
						type="button"
						onClick={reset}
						className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
					>
						<RotateCcw className="size-4" />
						Try again
					</button>
					<Link
						href="/"
						className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
					>
						Go home
					</Link>
				</div>
			</div>
		</div>
	);
}
