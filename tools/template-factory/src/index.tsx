#!/usr/bin/env bun
/**
 * Jack Template Factory
 *
 * A Smithers-powered autonomous workflow for creating new built-in templates.
 *
 * Usage:
 *   bun run factory "SaaS with Stripe payments"
 *   bun run factory --resume  # Resume previous execution
 */

import { mkdirSync, existsSync } from "node:fs";
import { createSmithersDB, createSmithersRoot } from "smithers-orchestrator";
import { TemplateFactory, STATE_KEYS } from "./TemplateFactory";
import type { TemplateIntent } from "./types";

// =============================================================================
// Configuration
// =============================================================================

const FACTORY_DB_DIR = ".smithers/template-factory";
const FACTORY_DB_PATH = `${FACTORY_DB_DIR}/smithers.db`;
const TEMPLATES_DIR = "./apps/cli/templates";

// =============================================================================
// CLI Argument Parsing
// =============================================================================

interface CliArgs {
  intent?: string;
  resume?: boolean;
  executionId?: string;
  help?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--resume" || arg === "-r") {
      result.resume = true;
    } else if (arg === "--execution" || arg === "-e") {
      result.executionId = args[++i];
    } else if (!arg.startsWith("-")) {
      result.intent = arg;
    }
  }

  return result;
}

function printHelp(): void {
  console.log(`
Jack Template Factory - Create new built-in templates with AI

USAGE:
  bun run factory <description>     Create a new template
  bun run factory --resume          Resume the last execution

EXAMPLES:
  bun run factory "Simple landing page with Astro"
  bun run factory "API starter with rate limiting"
  bun run factory "Blog template with markdown support"

OPTIONS:
  -h, --help              Show this help
  -r, --resume            Resume the most recent execution
  -e, --execution <id>    Resume a specific execution by ID

WORKFLOW:
  1. Spec       - AI creates a template specification
  2. Implement  - AI generates all template files
  3. Validate   - AI validates the structure
  4. Finalize   - AI registers and commits the template

The workflow is fully autonomous - just run and wait!
`);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.resume && !args.intent) {
    console.error("Error: Please provide a template description or use --resume");
    console.error('Example: bun run factory "Simple landing page"');
    process.exit(1);
  }

  // Initialize database
  console.log("Initializing Smithers database...");

  if (!existsSync(FACTORY_DB_DIR)) {
    mkdirSync(FACTORY_DB_DIR, { recursive: true });
  }

  const db = createSmithersDB({ path: FACTORY_DB_PATH });

  // Determine execution ID
  let executionId: string;
  let isResume = false;

  if (args.resume || args.executionId) {
    if (args.executionId) {
      executionId = args.executionId;
    } else {
      const lastExecution = db.state.get("factory:lastExecutionId");
      if (!lastExecution) {
        console.error("No previous execution found to resume");
        process.exit(1);
      }
      executionId = lastExecution as string;
    }
    isResume = true;
    console.log(`Resuming execution: ${executionId}`);
  } else {
    // Fresh start - clear all state
    console.log("Starting fresh execution...");
    db.db.run("DELETE FROM state WHERE key LIKE 'factory:%' OR key LIKE 'human:%' OR key LIKE 'stepIndex_%' OR key IN ('currentPhaseIndex', 'ralphCount', 'phase', 'data')");

    executionId = db.execution.start(
      `Template: ${args.intent!.slice(0, 40)}`,
      "template-factory"
    );
    db.state.set("factory:lastExecutionId", executionId);
    console.log(`Started execution: ${executionId}`);
  }

  const intent: TemplateIntent = {
    description: args.intent || (db.state.get(`${executionId}:intent`) as string) || "",
  };

  if (args.intent) {
    db.state.set(`${executionId}:intent`, args.intent);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Template: ${intent.description}`);
  console.log("=".repeat(60) + "\n");

  const root = createSmithersRoot();

  try {
    await root.mount(() => (
      <TemplateFactory
        db={db}
        executionId={executionId}
        intent={intent}
        templatesDir={TEMPLATES_DIR}
        onComplete={(result) => {
          console.log("\n" + "=".repeat(60));
          if (result.success) {
            console.log(`SUCCESS: Template "${result.templateName}" created!`);
            console.log(`\nNext steps:`);
            console.log(`  1. Review worktree: .worktrees/template/${result.templateName}/apps/cli/templates/${result.templateName}/`);
            console.log(`  2. Merge branch: git merge template/${result.templateName}`);
            console.log(`  3. Test: jack new my-test -t ${result.templateName}`);
          } else {
            console.log(`FAILED: ${result.error}`);
          }
          console.log("=".repeat(60));
          // Exit after completion
          setTimeout(() => process.exit(result.success ? 0 : 1), 500);
        }}
      />
    ));

    console.log("\nWorkflow completed.");
  } catch (error) {
    console.error("\nWorkflow error:", error);
    console.log(`\nTo resume: bun run factory --resume`);
    process.exit(1);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
