#!/usr/bin/env bun
/**
 * Migration script: Old registry → New .jack/project.json format
 *
 * Usage:
 *   bun scripts/migrate-registry.ts          # Dry run
 *   bun scripts/migrate-registry.ts --apply  # Actually migrate
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR = join(homedir(), ".config", "jack");
const OLD_REGISTRY = join(CONFIG_DIR, "projects.json");
const OLD_LOCAL_PATHS = join(CONFIG_DIR, "local-paths.json");
const NEW_PATHS_INDEX = join(CONFIG_DIR, "paths.json");

interface OldProject {
	workerUrl: string | null;
	createdAt: string;
	lastDeployed: string | null;
	status?: string;
	template?: { type: string; name: string };
	deploy_mode?: "managed" | "byo";
	remote?: {
		project_id: string;
		project_slug: string;
		org_id: string;
		runjack_url: string;
	};
	cloudflare?: {
		accountId: string;
		workerId: string;
	};
}

interface OldLocalPaths {
	version: number;
	paths: Record<string, string[]>;
	updatedAt: string;
}

interface NewProjectLink {
	version: 1;
	project_id: string;
	deploy_mode: "managed" | "byo";
	linked_at: string;
}

interface NewTemplateMetadata {
	type: string;
	name: string;
}

interface NewPathsIndex {
	version: 1;
	paths: Record<string, string[]>;
	updatedAt: string;
}

function generateByoId(): string {
	return `byo_${randomUUID()}`;
}

function ensureGitignored(projectDir: string): void {
	const gitignorePath = join(projectDir, ".gitignore");
	const entry = ".jack/";

	if (!existsSync(gitignorePath)) {
		writeFileSync(gitignorePath, `# Jack project link (local-only)\n${entry}\n`);
		return;
	}

	const content = readFileSync(gitignorePath, "utf-8");
	if (content.includes(entry)) return;

	appendFileSync(gitignorePath, `\n# Jack project link (local-only)\n${entry}\n`);
}

async function migrate(apply: boolean): Promise<void> {
	console.log(`\nJack Registry Migration ${apply ? "(APPLYING)" : "(Dry Run)"}`);
	console.log("=".repeat(50));

	// Load old data
	if (!existsSync(OLD_REGISTRY)) {
		console.log("\n❌ No old registry found at", OLD_REGISTRY);
		return;
	}

	const oldRegistry = JSON.parse(readFileSync(OLD_REGISTRY, "utf-8"));
	const projects: Record<string, OldProject> = oldRegistry.projects || {};

	let oldLocalPaths: OldLocalPaths = { version: 1, paths: {}, updatedAt: "" };
	if (existsSync(OLD_LOCAL_PATHS)) {
		oldLocalPaths = JSON.parse(readFileSync(OLD_LOCAL_PATHS, "utf-8"));
	}

	console.log(`\nFound ${Object.keys(projects).length} projects in old registry`);
	console.log(`Found ${Object.keys(oldLocalPaths.paths).length} local paths`);

	// Build migration plan
	interface MigrationItem {
		name: string;
		localPath: string;
		projectId: string;
		deployMode: "managed" | "byo";
		template?: { type: string; name: string };
		action: string;
	}

	const migrations: MigrationItem[] = [];
	const skipped: { name: string; path: string; reason: string }[] = [];
	const newPathsIndex: NewPathsIndex = {
		version: 1,
		paths: {},
		updatedAt: new Date().toISOString(),
	};

	// Process each local path
	for (const [projectName, paths] of Object.entries(oldLocalPaths.paths)) {
		for (const localPath of paths) {
			// Check if directory exists
			if (!existsSync(localPath)) {
				skipped.push({ name: projectName, path: localPath, reason: "directory not found" });
				continue;
			}

			// Check if already migrated
			const jackDir = join(localPath, ".jack");
			const projectJsonPath = join(jackDir, "project.json");
			if (existsSync(projectJsonPath)) {
				skipped.push({ name: projectName, path: localPath, reason: "already migrated" });
				continue;
			}

			// Find project in registry
			const project = projects[projectName];

			let projectId: string;
			let deployMode: "managed" | "byo";
			let template: { type: string; name: string } | undefined;

			if (project?.remote?.project_id) {
				// Managed project - use existing project_id
				projectId = project.remote.project_id;
				deployMode = "managed";
				template = project.template;
			} else {
				// BYO project - generate new ID
				projectId = generateByoId();
				deployMode = "byo";
				template = project?.template;
			}

			migrations.push({
				name: projectName,
				localPath,
				projectId,
				deployMode,
				template,
				action: `Create .jack/project.json (${deployMode})`,
			});

			// Add to new paths index
			if (!newPathsIndex.paths[projectId]) {
				newPathsIndex.paths[projectId] = [];
			}
			newPathsIndex.paths[projectId].push(localPath);
		}
	}

	// Display plan
	console.log("\n" + "─".repeat(50));
	console.log("MIGRATION PLAN");
	console.log("─".repeat(50));

	if (migrations.length > 0) {
		console.log(`\n✅ Will migrate ${migrations.length} project(s):\n`);
		for (const m of migrations) {
			console.log(`  ${m.name}`);
			console.log(`    Path: ${m.localPath}`);
			console.log(`    Mode: ${m.deployMode}`);
			console.log(`    ID:   ${m.projectId}`);
			if (m.template) {
				console.log(`    Template: ${m.template.type}/${m.template.name}`);
			}
			console.log();
		}
	}

	if (skipped.length > 0) {
		console.log(`\n⏭️  Skipping ${skipped.length} path(s):\n`);
		for (const s of skipped) {
			console.log(`  ${s.name}: ${s.reason}`);
			console.log(`    ${s.path}`);
		}
	}

	if (migrations.length === 0) {
		console.log("\n✨ Nothing to migrate!");
		return;
	}

	// Apply migrations
	if (!apply) {
		console.log("\n" + "─".repeat(50));
		console.log("Run with --apply to execute migration:");
		console.log("  bun scripts/migrate-registry.ts --apply");
		return;
	}

	console.log("\n" + "─".repeat(50));
	console.log("APPLYING MIGRATION");
	console.log("─".repeat(50));

	let successCount = 0;
	let errorCount = 0;

	for (const m of migrations) {
		try {
			const jackDir = join(m.localPath, ".jack");

			// Create .jack directory
			if (!existsSync(jackDir)) {
				mkdirSync(jackDir, { recursive: true });
			}

			// Write project.json
			const projectLink: NewProjectLink = {
				version: 1,
				project_id: m.projectId,
				deploy_mode: m.deployMode,
				linked_at: new Date().toISOString(),
			};
			writeFileSync(join(jackDir, "project.json"), JSON.stringify(projectLink, null, 2));

			// Write template.json if available
			if (m.template) {
				const templateMeta: NewTemplateMetadata = {
					type: m.template.type,
					name: m.template.name,
				};
				writeFileSync(join(jackDir, "template.json"), JSON.stringify(templateMeta, null, 2));
			}

			// Ensure .jack/ is gitignored
			ensureGitignored(m.localPath);

			console.log(`  ✅ ${m.name} → ${m.localPath}`);
			successCount++;
		} catch (err) {
			console.log(`  ❌ ${m.name}: ${err instanceof Error ? err.message : String(err)}`);
			errorCount++;
		}
	}

	// Write new paths index
	writeFileSync(NEW_PATHS_INDEX, JSON.stringify(newPathsIndex, null, 2));
	console.log(`\n  ✅ Updated ${NEW_PATHS_INDEX}`);

	// Summary
	console.log("\n" + "─".repeat(50));
	console.log("SUMMARY");
	console.log("─".repeat(50));
	console.log(`  Migrated: ${successCount}`);
	console.log(`  Errors:   ${errorCount}`);
	console.log(`  Skipped:  ${skipped.length}`);

	if (successCount > 0) {
		console.log("\n✨ Migration complete!");
		console.log("\nNext steps:");
		console.log("  1. Verify with: jack ls");
		console.log("  2. Optionally backup and delete old files:");
		console.log(`     mv ${OLD_REGISTRY} ${OLD_REGISTRY}.bak`);
		console.log(`     mv ${OLD_LOCAL_PATHS} ${OLD_LOCAL_PATHS}.bak`);
	}
}

// Run
const apply = process.argv.includes("--apply");
migrate(apply).catch(console.error);
