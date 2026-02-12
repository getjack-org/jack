export default function DashboardLoading() {
	return (
		<div className="min-h-screen">
			<header className="border-b border-gray-200 bg-white">
				<div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
					<div className="h-5 w-28 animate-pulse rounded bg-gray-200" />
					<div className="h-8 w-20 animate-pulse rounded bg-gray-200" />
				</div>
			</header>

			<main className="mx-auto max-w-3xl px-6 py-12">
				<div className="mb-8">
					<div className="h-8 w-40 animate-pulse rounded bg-gray-200" />
					<div className="mt-2 h-5 w-56 animate-pulse rounded bg-gray-200" />
				</div>

				<div className="grid gap-6 sm:grid-cols-2">
					<div className="rounded-xl border border-gray-200 bg-white p-6">
						<div className="h-5 w-16 animate-pulse rounded bg-gray-200" />
						<div className="mt-4 space-y-3">
							<div>
								<div className="h-3 w-12 animate-pulse rounded bg-gray-200" />
								<div className="mt-1.5 h-5 w-32 animate-pulse rounded bg-gray-200" />
							</div>
							<div>
								<div className="h-3 w-12 animate-pulse rounded bg-gray-200" />
								<div className="mt-1.5 h-5 w-44 animate-pulse rounded bg-gray-200" />
							</div>
						</div>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6">
						<div className="h-5 w-16 animate-pulse rounded bg-gray-200" />
						<div className="mt-4 space-y-3">
							<div>
								<div className="h-3 w-20 animate-pulse rounded bg-gray-200" />
								<div className="mt-1.5 h-5 w-48 animate-pulse rounded bg-gray-200" />
							</div>
							<div>
								<div className="h-3 w-16 animate-pulse rounded bg-gray-200" />
								<div className="mt-1.5 h-5 w-36 animate-pulse rounded bg-gray-200" />
							</div>
						</div>
					</div>
				</div>

				<div className="mt-8">
					<div className="h-10 w-28 animate-pulse rounded-lg bg-gray-200" />
				</div>
			</main>
		</div>
	);
}
