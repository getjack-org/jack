import { spawn } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { error, info, success } from "../lib/output.ts";
import { startMcpServer } from "../mcp/server.ts";

const cliRoot = fileURLToPath(new URL("../..", import.meta.url));

interface McpOptions {
	project?: string;
	debug?: boolean;
}

export default async function mcp(subcommand?: string, options: McpOptions = {}): Promise<void> {
	if (subcommand === "serve") {
		await startMcpServer({
			projectPath: options.project,
			debug: options.debug,
		});
		return;
	}

	if (subcommand === "test") {
		await testMcpServer();
		return;
	}

	error("Unknown subcommand. Use: jack mcp serve or jack mcp test");
	info("Usage:");
	info("  jack mcp serve [--project /path] [--debug]  Start MCP server");
	info("  jack mcp test                               Test MCP server connectivity");
	process.exit(1);
}

/**
 * Test MCP server by spawning it and sending test requests
 */
async function testMcpServer(): Promise<void> {
	const configDir = await mkdtemp(join(tmpdir(), "jack-config-"));

	info("Testing MCP server...\n");

	const proc = spawn("bun", ["run", "src/index.ts", "mcp", "serve"], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: cliRoot,
		env: {
			...process.env,
			CI: "1",
			JACK_TELEMETRY_DISABLED: "1",
			JACK_CONFIG_DIR: configDir,
		},
	});

	const results: { test: string; passed: boolean; error?: string }[] = [];

	const sendRequest = (id: number, method: string, params: object = {}): Promise<unknown> => {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);

			const handler = (data: Buffer) => {
				const lines = data.toString().split("\n").filter(Boolean);
				for (const line of lines) {
					try {
						const response = JSON.parse(line);
						if (response.id === id) {
							clearTimeout(timeout);
							proc.stdout.off("data", handler);
							if (response.error) {
								reject(new Error(response.error.message));
							} else {
								resolve(response.result);
							}
						}
					} catch {
						// Not JSON, ignore
					}
				}
			};

			proc.stdout.on("data", handler);
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
		});
	};

	try {
		// Test 1: Initialize
		info("1. Testing initialize...");
		const initResult = (await sendRequest(1, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "jack-mcp-test", version: "1.0" },
		})) as { serverInfo?: { name: string; version: string } };
		if (initResult?.serverInfo?.name === "jack") {
			results.push({ test: "initialize", passed: true });
			success(`   ✓ Server info: ${initResult.serverInfo.name} v${initResult.serverInfo.version}`);
		} else {
			results.push({ test: "initialize", passed: false, error: "Invalid response" });
		}

		// Test 2: List tools
		info("2. Testing tools/list...");
		const toolsResult = (await sendRequest(2, "tools/list")) as { tools?: { name: string }[] };
		const toolNames = toolsResult?.tools?.map((t) => t.name) ?? [];
		if (toolNames.length > 0) {
			results.push({ test: "tools/list", passed: true });
			success(`   ✓ Found ${toolNames.length} tools: ${toolNames.join(", ")}`);
		} else {
			results.push({ test: "tools/list", passed: false, error: "No tools found" });
		}

		// Test 3: List resources
		info("3. Testing resources/list...");
		const resourcesResult = (await sendRequest(3, "resources/list")) as {
			resources?: { name: string }[];
		};
		const resourceCount = resourcesResult?.resources?.length ?? 0;
		results.push({ test: "resources/list", passed: true });
		success(`   ✓ Found ${resourceCount} resource(s)`);

		// Test 4: Call list_projects tool
		info("4. Testing tools/call (list_projects)...");
		const callResult = (await sendRequest(4, "tools/call", {
			name: "list_projects",
			arguments: {},
		})) as { content?: { text: string }[] };
		const responseText = callResult?.content?.[0]?.text;
		if (responseText) {
			const parsed = JSON.parse(responseText);
			if (parsed.success) {
				results.push({ test: "tools/call", passed: true });
				success(`   ✓ list_projects returned ${parsed.data?.length ?? 0} projects`);
			} else {
				results.push({ test: "tools/call", passed: false, error: parsed.error?.message });
			}
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		results.push({ test: "unknown", passed: false, error: errorMsg });
		error(`   ✗ Error: ${errorMsg}`);
	} finally {
		proc.kill();
		await rm(configDir, { recursive: true, force: true });
	}

	// Summary
	console.log("");
	const passed = results.filter((r) => r.passed).length;
	const failed = results.filter((r) => !r.passed).length;

	if (failed === 0) {
		success(`All ${passed} tests passed! MCP server is working correctly.`);
	} else {
		error(`${failed}/${results.length} tests failed.`);
		for (const r of results.filter((r) => !r.passed)) {
			error(`  - ${r.test}: ${r.error}`);
		}
		process.exit(1);
	}
}
