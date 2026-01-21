/**
 * Database listing logic for jack services db list
 *
 * Lists D1 databases configured in wrangler.jsonc with their metadata.
 * For managed projects, fetches metadata via control plane instead of wrangler.
 */

import { join } from "node:path";
import { readProjectLink } from "../project-link.ts";
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
 * For managed projects: fetches metadata via control plane API.
 * For BYO projects: reads bindings from wrangler.jsonc and fetches metadata via wrangler.
 */
export async function listDatabases(projectDir: string): Promise<DatabaseListEntry[]> {
	const wranglerPath = join(projectDir, "wrangler.jsonc");

	// Get existing D1 bindings from wrangler.jsonc
	const bindings = await getExistingD1Bindings(wranglerPath);

	if (bindings.length === 0) {
		return [];
	}

	// Check deploy mode for metadata fetching
	const link = await readProjectLink(projectDir);
	const isManaged = link?.deploy_mode === "managed";

	// For managed projects, get metadata from control plane
	let managedDbInfo: { name: string; id: string; sizeBytes: number; numTables: number } | null =
		null;
	if (isManaged && link) {
		try {
			const { getManagedDatabaseInfo } = await import("../control-plane.ts");
			managedDbInfo = await getManagedDatabaseInfo(link.project_id);
		} catch {
			// Fall through - will show list without metadata
		}
	}

	// Fetch detailed info for each database
	const entries: DatabaseListEntry[] = [];

	for (const binding of bindings) {
		const entry: DatabaseListEntry = {
			name: binding.database_name,
			binding: binding.binding,
			id: binding.database_id,
		};

		// Get metadata based on deploy mode
		if (isManaged && managedDbInfo) {
			// For managed: use control plane data (match by ID or name)
			if (managedDbInfo.id === binding.database_id || managedDbInfo.name.includes(binding.database_name)) {
				entry.sizeBytes = managedDbInfo.sizeBytes;
				entry.numTables = managedDbInfo.numTables;
			}
		} else {
			// For BYO: try to get metadata via wrangler
			const info = await getDatabaseInfo(binding.database_name);
			if (info) {
				entry.sizeBytes = info.sizeBytes;
				entry.numTables = info.numTables;
			}
		}

		entries.push(entry);
	}

	return entries;
}
