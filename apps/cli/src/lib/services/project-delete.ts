/**
 * Project deletion service — shared between CLI (jack down --force) and MCP (delete_project).
 *
 * Handles both managed (control plane) and BYO (wrangler) deploy modes.
 * Non-fatal failures (export, individual resource) populate warnings[], not thrown.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	checkWorkerExists,
	deleteDatabase,
	deleteWorker,
	exportDatabase,
} from "../cloudflare-api.ts";
import { getJackHome } from "../config.ts";
import {
	deleteManagedProject,
	exportManagedDatabase,
	fetchProjectResources,
} from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";
import { parseWranglerResources } from "../resources.ts";
import { getProjectNameFromDir } from "../storage/index.ts";

export interface DeleteProjectOptions {
	exportDatabase?: boolean;
	exportDir?: string;
}

export interface DeleteProjectResult {
	projectName: string;
	deployMode: "managed" | "byo";
	workerDeleted: boolean;
	databaseDeleted: boolean;
	databaseName: string | null;
	databaseExportPath: string | null;
	resourceResults?: Array<{ resource: string; success: boolean; error?: string }>;
	warnings: string[];
}

export async function deleteProject(
	projectDir: string,
	options?: DeleteProjectOptions,
): Promise<DeleteProjectResult> {
	const exportDb = options?.exportDatabase ?? false;
	const warnings: string[] = [];

	const projectName = await getProjectNameFromDir(projectDir);
	const link = await readProjectLink(projectDir);
	const deployMode = link?.deploy_mode ?? "byo";

	if (deployMode === "managed" && link) {
		return deleteManagedFlow(link.project_id, projectName, projectDir, exportDb, options, warnings);
	}

	return deleteByoFlow(projectName, projectDir, exportDb, options, warnings);
}

async function deleteManagedFlow(
	projectId: string,
	projectName: string,
	projectDir: string,
	exportDb: boolean,
	options: DeleteProjectOptions | undefined,
	warnings: string[],
): Promise<DeleteProjectResult> {
	let databaseName: string | null = null;
	let databaseExportPath: string | null = null;

	// Resolve database name from control plane
	try {
		const resources = await fetchProjectResources(projectId);
		const d1 = resources.find((r) => r.resource_type === "d1");
		databaseName = d1?.resource_name ?? null;
	} catch {
		// Can't resolve — continue without DB info
	}

	// Optional export before deletion
	if (exportDb && databaseName) {
		const exportDir = options?.exportDir ?? projectDir ?? join(getJackHome(), projectName);
		mkdirSync(exportDir, { recursive: true });
		const exportPath = join(exportDir, `${projectName}-backup.sql`);

		try {
			const exportResult = await exportManagedDatabase(projectId);
			const response = await fetch(exportResult.download_url);
			if (!response.ok) {
				throw new Error(`Failed to download export: ${response.statusText}`);
			}
			const sqlContent = await response.text();
			await writeFile(exportPath, sqlContent, "utf-8");
			databaseExportPath = exportPath;
		} catch (err) {
			warnings.push(`Database export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Delete everything via control plane
	const result = await deleteManagedProject(projectId);

	for (const resource of result.resources) {
		if (!resource.success) {
			warnings.push(`Failed to delete ${resource.resource}: ${resource.error}`);
		}
	}

	return {
		projectName,
		deployMode: "managed",
		workerDeleted: true,
		databaseDeleted: databaseName !== null,
		databaseName,
		databaseExportPath,
		resourceResults: result.resources,
		warnings,
	};
}

async function deleteByoFlow(
	projectName: string,
	projectDir: string,
	exportDb: boolean,
	options: DeleteProjectOptions | undefined,
	warnings: string[],
): Promise<DeleteProjectResult> {
	let databaseName: string | null = null;
	let databaseExportPath: string | null = null;
	let databaseDeleted = false;
	let workerDeleted = false;

	// Resolve DB name from wrangler.jsonc
	try {
		const resources = await parseWranglerResources(projectDir);
		databaseName = resources.d1?.name ?? null;
	} catch {
		// Can't parse — continue without DB info
	}

	// Optional export before deletion
	if (exportDb && databaseName) {
		const exportDir = options?.exportDir ?? projectDir ?? join(getJackHome(), projectName);
		mkdirSync(exportDir, { recursive: true });
		const exportPath = join(exportDir, `${databaseName}-backup.sql`);

		try {
			await exportDatabase(databaseName, exportPath);
			databaseExportPath = exportPath;
		} catch (err) {
			warnings.push(`Database export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Delete worker
	const workerExists = await checkWorkerExists(projectName);
	if (workerExists) {
		try {
			await deleteWorker(projectName);
			workerDeleted = true;
		} catch (err) {
			warnings.push(`Worker deletion failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else {
		warnings.push(`Worker '${projectName}' not found — may already be deleted`);
	}

	// Delete database
	if (databaseName) {
		try {
			await deleteDatabase(databaseName);
			databaseDeleted = true;
		} catch (err) {
			warnings.push(
				`Database deletion failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		projectName,
		deployMode: "byo",
		workerDeleted,
		databaseDeleted,
		databaseName,
		databaseExportPath,
		warnings,
	};
}
