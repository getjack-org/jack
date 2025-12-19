import { error, info } from "../lib/output.ts";
import { startMcpServer } from "../mcp/server.ts";

interface McpOptions {
	project?: string;
}

export default async function mcp(subcommand?: string, options: McpOptions = {}): Promise<void> {
	if (subcommand !== "serve") {
		error("Unknown subcommand. Use: jack mcp serve");
		info("Usage: jack mcp serve [--project /path/to/project]");
		process.exit(1);
	}

	await startMcpServer({
		projectPath: options.project,
	});
}
