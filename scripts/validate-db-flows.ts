#!/usr/bin/env bun
/**
 * Database Flows Validation Script
 *
 * Tests the database binding flows to ensure they work correctly.
 * Run: bun run scripts/validate-db-flows.ts
 *
 * Phases:
 * - Phase 1: Delete flow (removes from cloud, control plane, and local)
 * - Phase 2: Auto-provision on deploy
 * - Phase 3: Sync after deploy + orphan detection
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Configuration
// ============================================================================

const WORK_DIR = join(tmpdir(), "jack-db-validation");
const RUN_ID = `dbval-${Date.now().toString(36)}`;
const PROJECT_NAME = `db-val-${RUN_ID}`;

const COLORS = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	dim: "\x1b[2m",
};

// ============================================================================
// Utilities
// ============================================================================

function log(msg: string, color = COLORS.reset) {
	console.log(`${color}${msg}${COLORS.reset}`);
}

function logStep(step: string) {
	log(`\n${"=".repeat(60)}`, COLORS.blue);
	log(`  ${step}`, COLORS.blue);
	log("=".repeat(60), COLORS.blue);
}

function logPass(test: string) {
	log(`  ✓ ${test}`, COLORS.green);
}

function logFail(test: string, reason?: string) {
	log(`  ✗ ${test}`, COLORS.red);
	if (reason) log(`    ${reason}`, COLORS.dim);
}

function logWarn(msg: string) {
	log(`  ⚠ ${msg}`, COLORS.yellow);
}

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

async function run(cmd: string, args: string[], cwd?: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, {
			cwd: cwd || process.cwd(),
			env: { ...process.env, CI: "1", JACK_TELEMETRY_DISABLED: "1" },
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		proc.on("close", (exitCode) => {
			resolve({ exitCode, stdout, stderr });
		});
	});
}

async function jack(args: string[], cwd?: string): Promise<CommandResult> {
	log(`  $ jack ${args.join(" ")}`, COLORS.dim);
	return run("jack", args, cwd);
}

async function wrangler(args: string[], cwd?: string): Promise<CommandResult> {
	log(`  $ wrangler ${args.join(" ")}`, COLORS.dim);
	return run("wrangler", args, cwd);
}

function readWranglerConfig(projectDir: string): Record<string, unknown> | null {
	const configPath = join(projectDir, "wrangler.jsonc");
	if (!existsSync(configPath)) return null;

	const content = readFileSync(configPath, "utf-8");
	// Simple JSONC parser (strips // comments)
	const jsonContent = content.replace(/\/\/.*$/gm, "");
	try {
		return JSON.parse(jsonContent);
	} catch {
		return null;
	}
}

function getD1Bindings(
	projectDir: string,
): Array<{ binding: string; database_name: string; database_id: string }> {
	const config = readWranglerConfig(projectDir);
	if (!config) return [];
	const d1 = config.d1_databases as Array<Record<string, string>> | undefined;
	return d1 || [];
}

// ============================================================================
// Test Cases
// ============================================================================

interface TestResult {
	name: string;
	passed: boolean;
	reason?: string;
}

const results: TestResult[] = [];

function recordTest(name: string, passed: boolean, reason?: string) {
	results.push({ name, passed, reason });
	if (passed) {
		logPass(name);
	} else {
		logFail(name, reason);
	}
}

// ============================================================================
// Phase 1: Basic Flow Tests (Current Behavior)
// ============================================================================

async function testPhase1(projectDir: string) {
	logStep("Phase 1: Testing Current DB Flows");

	// Test 1.1: Create DB
	log("\n  Test 1.1: Create database");
	const createResult = await jack(["services", "db", "create", "--name", "testdb"], projectDir);

	if (createResult.exitCode === 0) {
		recordTest("DB create succeeds", true);
	} else {
		recordTest("DB create succeeds", false, createResult.stderr);
		return; // Can't continue without DB
	}

	// Verify wrangler.jsonc has binding
	const bindings = getD1Bindings(projectDir);
	if (bindings.length > 0 && bindings.some((b) => b.database_name?.includes("testdb"))) {
		recordTest("wrangler.jsonc has d1_databases entry", true);
	} else {
		recordTest(
			"wrangler.jsonc has d1_databases entry",
			false,
			`Found: ${JSON.stringify(bindings)}`,
		);
	}

	// Test 1.2: Deploy
	log("\n  Test 1.2: Deploy with DB");
	const deployResult = await jack(["ship"], projectDir);

	if (deployResult.exitCode === 0) {
		recordTest("Deploy with DB succeeds", true);
	} else {
		recordTest("Deploy with DB succeeds", false, deployResult.stderr.slice(0, 200));
	}

	// Test 1.3: Execute SQL
	log("\n  Test 1.3: Execute SQL");
	const createTableResult = await jack(
		[
			"services",
			"db",
			"execute",
			"CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)",
			"--write",
		],
		projectDir,
	);

	if (createTableResult.exitCode === 0) {
		recordTest("CREATE TABLE succeeds", true);
	} else {
		recordTest("CREATE TABLE succeeds", false, createTableResult.stderr);
	}

	const insertResult = await jack(
		["services", "db", "execute", "INSERT INTO test (name) VALUES ('hello')", "--write"],
		projectDir,
	);

	if (insertResult.exitCode === 0) {
		recordTest("INSERT succeeds", true);
	} else {
		recordTest("INSERT succeeds", false, insertResult.stderr);
	}

	const selectResult = await jack(["services", "db", "execute", "SELECT * FROM test"], projectDir);

	if (selectResult.exitCode === 0 && selectResult.stdout.includes("hello")) {
		recordTest("SELECT returns data", true);
	} else {
		recordTest("SELECT returns data", false, selectResult.stdout.slice(0, 200));
	}

	// Test 1.4: Delete DB (this is the bug we're fixing)
	log("\n  Test 1.4: Delete DB");
	// Note: This test documents current (buggy) behavior
	// After fix, all three checks should pass

	const bindingsBeforeDelete = getD1Bindings(projectDir);
	const dbNameBeforeDelete = bindingsBeforeDelete[0]?.database_name;

	// Simulate user confirming delete (non-interactive)
	// Note: In real usage, this prompts. For testing, we'd need --force flag
	logWarn("Skipping delete test (requires interactive confirmation)");
	logWarn("Manual test: run 'jack services db delete' and verify:");
	logWarn("  1. wrangler.jsonc binding removed");
	logWarn("  2. 'wrangler d1 list' doesn't show the DB");
	logWarn("  3. Control plane resource marked deleted");

	// We could add a --force flag to db delete for testing
	// For now, just verify the DB exists
	const listResult = await wrangler(["d1", "list", "--json"], projectDir);
	if (
		listResult.exitCode === 0 &&
		dbNameBeforeDelete &&
		listResult.stdout.includes(dbNameBeforeDelete)
	) {
		recordTest("DB exists in Cloudflare (pre-delete)", true);
	} else {
		recordTest("DB exists in Cloudflare (pre-delete)", false);
	}
}

// ============================================================================
// Phase 2: Auto-Provision Tests (After Implementation)
// ============================================================================

async function testPhase2(projectDir: string) {
	logStep("Phase 2: Auto-Provision on Deploy (Future)");

	logWarn("Phase 2 tests require implementation of auto-provision feature");
	logWarn("After implementation, these tests will verify:");
	logWarn("  1. Adding binding to wrangler.jsonc auto-creates DB on deploy");
	logWarn("  2. Multiple DBs can be provisioned in single deploy");
	logWarn("  3. Existing DB is reused when binding name matches");

	// Placeholder for future tests
	recordTest("[PENDING] Auto-provision single DB", false, "Not yet implemented");
	recordTest("[PENDING] Auto-provision multiple DBs", false, "Not yet implemented");
	recordTest("[PENDING] Reuse existing by binding name", false, "Not yet implemented");
}

// ============================================================================
// Phase 3: Sync Tests (After Implementation)
// ============================================================================

async function testPhase3(projectDir: string) {
	logStep("Phase 3: Sync After Deploy (Future)");

	logWarn("Phase 3 tests require implementation of sync feature");
	logWarn("After implementation, these tests will verify:");
	logWarn("  1. wrangler.jsonc updated with correct IDs after deploy");
	logWarn("  2. Local drift (wrong ID) is corrected on deploy");
	logWarn("  3. Orphaned DBs prompt for deletion");

	// Placeholder for future tests
	recordTest("[PENDING] Sync updates local after deploy", false, "Not yet implemented");
	recordTest("[PENDING] Sync fixes local drift", false, "Not yet implemented");
	recordTest("[PENDING] Orphan detection prompts user", false, "Not yet implemented");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	log(`\n${"#".repeat(60)}`, COLORS.blue);
	log("#  Jack Database Flows Validation", COLORS.blue);
	log("#  Run ID: " + RUN_ID, COLORS.blue);
	log("#".repeat(60), COLORS.blue);

	// Setup
	logStep("Setup");
	log(`  Work directory: ${WORK_DIR}`);
	log(`  Project name: ${PROJECT_NAME}`);

	if (existsSync(WORK_DIR)) {
		log("  Cleaning previous work directory...");
		await rm(WORK_DIR, { recursive: true });
	}
	await mkdir(WORK_DIR, { recursive: true });

	// Create project
	log("\n  Creating test project...");
	const newResult = await jack(["new", PROJECT_NAME, "--template", "api"], WORK_DIR);

	if (newResult.exitCode !== 0) {
		log("\nFailed to create project:", COLORS.red);
		log(newResult.stderr, COLORS.red);
		process.exit(1);
	}

	const projectDir = join(WORK_DIR, PROJECT_NAME);
	log(`  Project created at: ${projectDir}`);

	// Run tests
	try {
		await testPhase1(projectDir);
		await testPhase2(projectDir);
		await testPhase3(projectDir);
	} catch (err) {
		log(`\nTest error: ${err}`, COLORS.red);
	}

	// Summary
	logStep("Summary");
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;
	const pending = results.filter((r) => r.name.startsWith("[PENDING]")).length;

	log(`\n  Passed:  ${passed}`, COLORS.green);
	log(`  Failed:  ${failed - pending}`, failed > pending ? COLORS.red : COLORS.reset);
	log(`  Pending: ${pending}`, COLORS.yellow);

	// Cleanup prompt
	logStep("Cleanup");
	log(`\n  To clean up test project:`);
	log(`    jack down --project ${PROJECT_NAME}`, COLORS.dim);
	log(`    rm -rf ${WORK_DIR}`, COLORS.dim);

	// Exit code
	const actualFailures = failed - pending;
	if (actualFailures > 0) {
		log(`\n  ${actualFailures} test(s) failed!`, COLORS.red);
		process.exit(1);
	} else {
		log(`\n  All implemented tests passed!`, COLORS.green);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
