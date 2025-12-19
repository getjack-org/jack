import { $ } from "bun";

/**
 * Get the Cloudflare account ID from wrangler whoami
 */
export async function getAccountId(): Promise<string> {
	const result = await $`wrangler whoami`.quiet();

	if (result.exitCode !== 0) {
		throw new Error("Failed to get account ID. Are you authenticated?");
	}

	const output = result.stdout.toString();
	// wrangler whoami outputs a table like:
	// │ Account Name   │ 26927580508a6da4ea3169bdc5c23418 │
	const match = output.match(/│[^│]+│\s*([a-f0-9]{32})\s*│/);

	if (!match?.[1]) {
		throw new Error("Could not parse account ID from wrangler whoami");
	}

	return match[1];
}

/**
 * Check if a worker exists by attempting to list its deployments
 */
export async function checkWorkerExists(name: string): Promise<boolean> {
	const result = await $`wrangler deployments list --name ${name}`.nothrow().quiet();
	return result.exitCode === 0;
}

/**
 * Delete a worker with force flag (no confirmation)
 */
export async function deleteWorker(name: string): Promise<void> {
	const result = await $`wrangler delete --name ${name} --force`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to delete worker ${name}`);
	}
}

/**
 * Export a D1 database to a SQL file
 */
export async function exportDatabase(dbName: string, outputPath: string): Promise<void> {
	const result = await $`wrangler d1 export ${dbName} --output ${outputPath}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to export database ${dbName} to ${outputPath}`);
	}
}

/**
 * Delete a D1 database without confirmation
 */
export async function deleteDatabase(dbName: string): Promise<void> {
	const result = await $`wrangler d1 delete ${dbName} --skip-confirmation`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error(`Failed to delete database ${dbName}`);
	}
}

/**
 * List all workers for the current account
 * Parses the output of `wrangler deployments list` to extract worker names
 */
export async function listWorkers(): Promise<string[]> {
	const result = await $`wrangler deployments list`.nothrow().quiet();

	if (result.exitCode !== 0) {
		throw new Error("Failed to list workers");
	}

	const output = result.stdout.toString();
	const workers: string[] = [];

	// Parse the table output to extract worker names
	// Format is typically: │ Worker Name │ ...
	const lines = output.split("\n");
	for (const line of lines) {
		// Match worker name from table rows (not headers or separators)
		const match = line.match(/│\s*([a-zA-Z0-9_-]+)\s*│/);
		if (match?.[1] && !match[1].match(/^(Worker|Name|─+)$/i)) {
			workers.push(match[1]);
		}
	}

	return workers;
}
