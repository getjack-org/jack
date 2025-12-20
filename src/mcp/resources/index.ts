import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import {
	ListResourcesRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
			],
		};
	});

	// Register resource read handler
	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const uri = request.params.uri;
		debug("resources/read requested", { uri });

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

			if (contents.length === 0) {
				return {
					contents: [
						{
							uri,
							mimeType: "text/plain",
							text: "No agent context files found in project directory",
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
