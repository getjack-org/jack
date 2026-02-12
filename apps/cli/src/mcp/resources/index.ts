import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import packageJson from "../../../package.json" with { type: "json" };
import type { DebugLogger, McpServerOptions } from "../types.ts";

export function registerResources(
	server: McpServer,
	options: McpServerOptions,
	debug: DebugLogger,
) {
	// Register resource list handler
	server.setRequestHandler(ListResourcesRequestSchema, async () => {
		debug("resources/list requested");
		return {
			resources: [
				{
					uri: "agents://context",
					name: "Agent Context Files",
					description:
						"Project-specific context files (AGENTS.md, CLAUDE.md) for AI agents working on this project",
					mimeType: "text/markdown",
				},
				{
					uri: "jack://capabilities",
					name: "Jack Capabilities",
					description: "Semantic information about jack's capabilities for AI agents",
					mimeType: "application/json",
				},
				{
					uri: "agents://workflows",
					name: "Workflow Recipes",
					description:
						"Multi-step workflow templates for common tasks like creating APIs with databases, debugging production issues, and setting up cron jobs",
					mimeType: "text/markdown",
				},
			],
		};
	});

	// Register resource read handler
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const uri = request.params.uri;
		debug("resources/read requested", { uri });

		if (uri === "jack://capabilities") {
			const capabilities = {
				version: packageJson.version,
				services: {
					supported: ["d1", "kv", "r2"],
					create_supported: ["d1", "r2"],
				},
				guidance: {
					prefer_jack_over_wrangler: true,
					database_creation: "Use create_database tool or jack services db create",
					deployment: "Use deploy_project tool or jack ship",
				},
			};

			return {
				contents: [
					{
						uri,
						mimeType: "application/json",
						text: JSON.stringify(capabilities, null, 2),
					},
				],
			};
		}

		if (uri === "agents://context") {
			const projectPath = options.projectPath ?? process.cwd();
			const agentsPath = join(projectPath, "AGENTS.md");
			const claudePath = join(projectPath, "CLAUDE.md");

			const contents: string[] = [];

			// Try to read AGENTS.md
			if (existsSync(agentsPath)) {
				try {
					const agentsContent = await Bun.file(agentsPath).text();
					contents.push("# AGENTS.md\n\n");
					contents.push(agentsContent);
				} catch {
					// Ignore read errors
				}
			}

			// Try to read CLAUDE.md
			if (existsSync(claudePath)) {
				try {
					const claudeContent = await Bun.file(claudePath).text();
					if (contents.length > 0) {
						contents.push("\n\n---\n\n");
					}
					contents.push("# CLAUDE.md\n\n");
					contents.push(claudeContent);
				} catch {
					// Ignore read errors
				}
			}

			// If no agent files found, return jack guidance as fallback
			if (contents.length === 0) {
				const fallbackGuidance = `# Jack Project

This project is managed by jack.

## Commands
- \`jack ship\` - Deploy changes
- \`jack logs\` - Stream production logs
- \`jack services\` - Manage databases and other services

**Always use jack commands. Never use wrangler directly.**

## MCP Tools Available

If connected, prefer \`mcp__jack__*\` tools over CLI:
- \`mcp__jack__deploy_project\` - Deploy changes
- \`mcp__jack__execute_sql\` - Query databases
- \`mcp__jack__get_project_status\` - Check status

## Documentation

Full docs: https://docs.getjack.org/llms-full.txt

Check AGENTS.md in the project root for project-specific instructions.
`;
				return {
					contents: [
						{
							uri,
							mimeType: "text/markdown",
							text: fallbackGuidance,
						},
					],
				};
			}

			return {
				contents: [
					{
						uri,
						mimeType: "text/markdown",
						text: contents.join(""),
					},
				],
			};
		}

		if (uri === "agents://workflows") {
			const workflows = `# Jack Workflow Recipes

Multi-step workflows for common tasks. Each workflow can be executed by an agent team or a single agent working sequentially.

---

## 1. Create API with Database

Goal: Scaffold a new API, add a database, create tables, and verify.

\`\`\`
Step 1: Create project
  jack new my-api --template api

Step 2: Add database
  mcp__jack__create_database (or: jack services db create)

Step 3: Create schema
  mcp__jack__execute_sql
    sql: "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"
    allow_write: true

Step 4: Edit src/index.ts — add routes that use c.env.DB

Step 5: Deploy
  mcp__jack__deploy_project (or: jack ship)

Step 6: Verify
  curl https://<slug>.runjack.xyz/api/items
\`\`\`

---

## 2. Debug Production Issue

Goal: Identify and fix a bug reported in production.

\`\`\`
Step 1: Check current status
  mcp__jack__get_project_status (or: jack info)

Step 2: Collect recent logs
  mcp__jack__tail_logs with max_events: 100, duration_ms: 5000

Step 3: Inspect database state if relevant
  mcp__jack__execute_sql
    sql: "SELECT * FROM <table> WHERE <condition>"

Step 4: Read and fix the source code

Step 5: Deploy fix
  mcp__jack__deploy_project (or: jack ship)

Step 6: Verify fix via logs
  mcp__jack__tail_logs with max_events: 20, duration_ms: 3000
\`\`\`

---

## 3. Add Scheduled Task (Cron)

Goal: Run code on a schedule (cleanup, sync, reports).

\`\`\`
Step 1: Add scheduled handler to src/index.ts
  export default {
    async fetch(request, env) { ... },
    async scheduled(event, env, ctx) {
      // your cron logic here
    },
  };

  Or with Hono, add a POST /__scheduled route.

Step 2: Deploy the handler
  mcp__jack__deploy_project (or: jack ship)

Step 3: Create cron schedule
  mcp__jack__create_cron with expression: "0 * * * *"
  (or: jack services cron create "0 * * * *")

Step 4: Verify schedule
  mcp__jack__test_cron with expression: "0 * * * *"
  Shows next 5 scheduled times.

Step 5: Monitor via logs
  mcp__jack__tail_logs
\`\`\`

---

## 4. Add File Storage

Goal: Enable file uploads and downloads via R2.

\`\`\`
Step 1: Create storage bucket
  mcp__jack__create_storage_bucket (or: jack services storage create)

Step 2: Deploy to activate binding
  mcp__jack__deploy_project (or: jack ship)

Step 3: Add upload/download routes to src/index.ts
  Upload:  c.env.BUCKET.put(key, body)
  Download: c.env.BUCKET.get(key)
  List:    c.env.BUCKET.list()

Step 4: Deploy routes
  mcp__jack__deploy_project (or: jack ship)
\`\`\`

---

## 5. Add Semantic Search (Vectorize + AI)

Goal: Enable vector similarity search using embeddings.

\`\`\`
Step 1: Create vector index
  mcp__jack__create_vectorize_index (or: jack services vectorize create)
  Default: 768 dimensions, cosine metric (matches bge-base-en-v1.5)

Step 2: Deploy to activate binding
  mcp__jack__deploy_project (or: jack ship)

Step 3: Add indexing route
  Generate embedding: c.env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [input] })
  Insert: c.env.VECTORIZE_INDEX.insert([{ id, values, metadata }])

Step 4: Add search route
  Generate query embedding, then:
  c.env.VECTORIZE_INDEX.query(embedding, { topK: 5, returnMetadata: "all" })

Step 5: Deploy and test
  mcp__jack__deploy_project (or: jack ship)
\`\`\`

---

## Parallel Task Patterns (Agent Teams)

For Opus 4.6 Agent Teams, these tasks can run in parallel:

**Independent (run simultaneously):**
- Creating database + creating storage bucket
- Reading logs + checking project status
- Multiple SQL queries on different tables

**Sequential (must wait for previous):**
- Create project → then add services
- Create database → then create tables → then deploy
- Edit code → then deploy → then verify
`;

			return {
				contents: [
					{
						uri,
						mimeType: "text/markdown",
						text: workflows,
					},
				],
			};
		}

		throw new Error(`Unknown resource URI: ${uri}`);
	});
}
