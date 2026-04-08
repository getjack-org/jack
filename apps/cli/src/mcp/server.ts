import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../../package.json" with { type: "json" };
import { startChannelLogSubscriber } from "./channel/log-subscriber.ts";
import { registerResources } from "./resources/index.ts";
import { registerTools } from "./tools/index.ts";
import type { McpServerOptions } from "./types.ts";

/**
 * Debug logger that writes to stderr (doesn't interfere with stdio MCP protocol)
 */
export function createDebugLogger(enabled: boolean) {
	return (message: string, data?: unknown) => {
		if (!enabled) return;
		const timestamp = new Date().toISOString();
		const line = data
			? `[jack-mcp ${timestamp}] ${message}: ${JSON.stringify(data)}`
			: `[jack-mcp ${timestamp}] ${message}`;
		console.error(line);
	};
}

const CHANNEL_INSTRUCTIONS = `Events from the jack channel are production alerts from your deployed project.
They arrive as <channel source="jack" event="..." ...> tags.

- event="error": A request to your deployed app hit an error. Read the error message,
  find the relevant source code, and suggest a fix. Use tail_logs to check if it's
  recurring. Use test_endpoint to reproduce if possible.
- event="exception": An uncaught exception in your deployed code. Check the source,
  understand the cause, and suggest a fix.
- outcome="exceededCpu" / "exceededMemory" / "exceededWallTime": A resource limit was hit.
  Suggest code optimization rather than looking for bugs.

If you see the same error repeatedly, diagnose it once and note the frequency.
Do NOT redeploy automatically. Present the fix and let the user decide.`;

export async function createMcpServer(options: McpServerOptions = {}) {
	const debug = createDebugLogger(options.debug ?? false);

	debug("Creating MCP server", { version: pkg.version, options });

	const server = new McpServer(
		{
			name: "jack",
			version: pkg.version,
		},
		{
			capabilities: {
				tools: {},
				resources: {},
				experimental: { "claude/channel": {} },
			},
			instructions: CHANNEL_INSTRUCTIONS,
		},
	);

	registerTools(server, options, debug);
	registerResources(server, options, debug);

	return { server, debug };
}

/**
 * Install runtime guards that prevent accidental stdout writes from corrupting
 * the MCP JSON-RPC stdio transport. This catches console.log() and
 * process.stdout.write() but NOT Bun.spawn({ stdout: "inherit" }) which writes
 * directly to fd 1 — that case is handled by the `interactive` flag in hooks.
 */
function installStdoutGuards() {
	// Redirect console.log to stderr so accidental calls don't corrupt the stream.
	// We don't wrap process.stdout.write because the MCP SDK writes JSON-RPC
	// messages through it — intercepting those risks breaking the protocol if
	// messages are chunked or newlines are written separately.
	console.log = (...args: unknown[]) => {
		console.error(
			"[jack-mcp] WARNING: console.log intercepted (would corrupt MCP protocol):",
			...args,
		);
	};
}

export async function startMcpServer(options: McpServerOptions = {}) {
	const { server, debug } = await createMcpServer(options);

	// Install stdout guards BEFORE connecting transport to prevent corruption
	installStdoutGuards();

	const transport = new StdioServerTransport();

	debug("Starting MCP server on stdio transport");

	// Process-level error handlers to prevent silent crashes
	process.on("uncaughtException", (error) => {
		console.error(`[jack-mcp] Uncaught exception: ${error.message}`);
		debug("Uncaught exception", { error: error.stack });
		process.exit(1);
	});

	process.on("unhandledRejection", (reason) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		console.error(`[jack-mcp] Unhandled rejection: ${message}`);
		debug("Unhandled rejection", { reason });
		process.exit(1);
	});

	// Always log startup to stderr so user knows it's running
	console.error(
		`[jack-mcp] Server started (v${pkg.version})${options.debug ? " [debug mode]" : ""}`,
	);

	await server.connect(transport);

	// Start channel log subscriber for production error streaming (fire-and-forget)
	startChannelLogSubscriber(server, options, debug).catch((err) =>
		debug("Channel log subscriber failed to start", { error: String(err) }),
	);

	debug("MCP server connected and ready");

	// Keep the server running indefinitely.
	// This blocks the async function from returning, preventing the caller from
	// falling through to any cleanup/exit code (like process.exit(0) in index.ts).
	// The process will stay alive via stdin event listeners in the transport.
	await new Promise(() => {});
}
