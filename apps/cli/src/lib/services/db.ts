import { $ } from "bun";

export interface DatabaseInfo {
	name: string;
	id: string;
	sizeBytes: number;
	numTables: number;
}

/**
 * Get database info via wrangler d1 info
 */
export async function getDatabaseInfo(dbName: string): Promise<DatabaseInfo | null> {
	const result = await $`wrangler d1 info ${dbName} --json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		return null;
	}

	try {
		const output = result.stdout.toString().trim();
		const data = JSON.parse(output);

		// wrangler d1 info --json returns:
		// {
		//   "uuid": "...",
		//   "name": "...",
		//   "version": "...",
		//   "num_tables": N,
		//   "file_size": N
		// }
		return {
			name: data.name || dbName,
			id: data.uuid || "",
			sizeBytes: data.file_size || 0,
			numTables: data.num_tables || 0,
		};
	} catch (error) {
		// Failed to parse JSON output
		return null;
	}
}

/**
 * Export database to SQL file
 */
export async function exportDatabase(dbName: string, outputPath: string): Promise<void> {
	const result = await $`wrangler d1 export ${dbName} --output ${outputPath}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to export database ${dbName} to ${outputPath}`);
	}
}

/**
 * Generate export filename with timestamp
 * Format: {db-name}-{YYYY-MM-DD-HHMMSS}.sql
 */
export function generateExportFilename(dbName: string): string {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${dbName}-${year}-${month}-${day}-${hours}${minutes}${seconds}.sql`;
}

/**
 * Delete database via wrangler
 */
export async function deleteDatabase(dbName: string): Promise<void> {
	const result = await $`wrangler d1 delete ${dbName} --skip-confirmation`.nothrow().quiet();

	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim();
		throw new Error(stderr || `Failed to delete database ${dbName}`);
	}
}
