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
					create_supported: ["d1"],
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
			const jackPath = join(projectPath, "JACK.md");
			const agentsPath = join(projectPath, "AGENTS.md");
			const claudePath = join(projectPath, "CLAUDE.md");

			const contents: string[] = [];

			// Try to read JACK.md first (jack-specific context)
			if (existsSync(jackPath)) {
				try {
					const jackContent = await Bun.file(jackPath).text();
					contents.push("# JACK.md\n\n");
					contents.push(jackContent);
				} catch {
					// Ignore read errors
				}
			}

			// Try to read AGENTS.md
			if (existsSync(agentsPath)) {
				try {
					const agentsContent = await Bun.file(agentsPath).text();
					if (contents.length > 0) {
						contents.push("\n\n---\n\n");
					}
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

Check for JACK.md in the project root for project-specific instructions.
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

		throw new Error(`Unknown resource URI: ${uri}`);
	});
}
