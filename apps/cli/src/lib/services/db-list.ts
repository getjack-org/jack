/**
 * Database listing logic for jack services db list
 *
 * Lists D1 databases configured in wrangler.jsonc with their metadata.
 */

import { join } from "node:path";
import { getExistingD1Bindings } from "../wrangler-config.ts";
import { getDatabaseInfo } from "./db.ts";

export interface DatabaseListEntry {
	name: string;
	binding: string;
	id: string;
	sizeBytes?: number;
	numTables?: number;
}

/**
 * List all D1 databases configured for a project.
 *
 * Reads bindings from wrangler.jsonc and fetches additional metadata
 * (size, table count) via wrangler d1 info for each database.
 */
export async function listDatabases(projectDir: string): Promise<DatabaseListEntry[]> {
	const wranglerPath = join(projectDir, "wrangler.jsonc");

	// Get existing D1 bindings from wrangler.jsonc
	const bindings = await getExistingD1Bindings(wranglerPath);

	if (bindings.length === 0) {
		return [];
	}

	// Fetch detailed info for each database
	const entries: DatabaseListEntry[] = [];

	for (const binding of bindings) {
		const entry: DatabaseListEntry = {
			name: binding.database_name,
			binding: binding.binding,
			id: binding.database_id,
		};

		// Try to get additional metadata via wrangler
		const info = await getDatabaseInfo(binding.database_name);
		if (info) {
			entry.sizeBytes = info.sizeBytes;
			entry.numTables = info.numTables;
		}

		entries.push(entry);
	}

	return entries;
}
