#!/usr/bin/env bun
/**
 * Simple script to approve/reject pending human interactions
 *
 * Usage:
 *   bun run scripts/approve.ts           # List pending interactions
 *   bun run scripts/approve.ts approve   # Approve first pending
 *   bun run scripts/approve.ts reject    # Reject first pending
 *   bun run scripts/approve.ts approve <id>  # Approve specific ID
 */

import { createSmithersDB } from "smithers-orchestrator";

const FACTORY_DB_PATH = ".smithers/template-factory/smithers.db";

async function main() {
	const action = process.argv[2];
	const targetId = process.argv[3];

	const db = createSmithersDB({ path: FACTORY_DB_PATH });

	// Get pending interactions
	const pending = db.human.listPending("*");

	if (pending.length === 0) {
		console.log("No pending human interactions.");
		await db.close();
		return;
	}

	if (!action) {
		// List mode
		console.log("\nPending Human Interactions:\n");
		for (const req of pending) {
			console.log(`  ID: ${req.id}`);
			console.log(`  Type: ${req.type}`);
			console.log(`  Prompt: ${req.prompt}`);
			console.log(`  Created: ${req.created_at}`);
			console.log("");
		}
		console.log(`\nTo approve: bun run scripts/approve.ts approve`);
		console.log(`To reject:  bun run scripts/approve.ts reject`);
	} else if (action === "approve" || action === "reject") {
		const target = targetId
			? pending.find((p) => p.id === targetId || p.id.startsWith(targetId))
			: pending[0];

		if (!target) {
			console.error(`No pending interaction found${targetId ? ` with ID ${targetId}` : ""}`);
			await db.close();
			process.exit(1);
		}

		const status = action === "approve" ? "approved" : "rejected";
		db.human.resolve(target.id, status, null);

		// Also complete the human_interaction task so the workflow can proceed
		// The Human component creates a task that blocks until resolved
		const runningTask = db.db.queryOne<{ id: string }>(
			`SELECT id FROM tasks WHERE component_type = 'human_interaction' AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
		);
		if (runningTask) {
			db.tasks.complete(runningTask.id);
			console.log(`Completed blocking task: ${runningTask.id}`);
		}

		// Also set the specApproved state if this was a spec review
		if (target.prompt.includes("spec")) {
			db.state.set("factory:spec:approved", action === "approve");
		}

		console.log(`\n${action === "approve" ? "✓ Approved" : "✗ Rejected"}: ${target.prompt}`);
		console.log(`ID: ${target.id}`);
	} else {
		console.error(`Unknown action: ${action}`);
		console.error("Use: approve, reject, or no argument to list");
	}

	await db.close();
}

main().catch(console.error);
