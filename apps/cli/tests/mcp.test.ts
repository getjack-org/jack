import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "bun:test";
import {
	callMcpListProjects,
	openMcpTestClient,
	verifyMcpToolsAndResources,
} from "../src/mcp/test-utils.ts";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));

// Pre-test: verify the MCP server can start without crashing
test("MCP server starts without immediate crash", async () => {
	const configDir = await mkdtemp(join(tmpdir(), "jack-config-"));
	const projectDir = await mkdtemp(join(tmpdir(), "jack-mcp-test-"));

	const proc = spawn("bun", ["run", "src/index.ts", "mcp", "serve", "--project", projectDir], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: cliRoot,
		env: {
			...process.env,
			CI: "1",
			JACK_TELEMETRY_DISABLED: "1",
			JACK_CONFIG_DIR: configDir,
		},
	});

	let stdout = "";
	let stderr = "";
	proc.stdout?.on("data", (d) => (stdout += d.toString()));
	proc.stderr?.on("data", (d) => (stderr += d.toString()));

	// Wait a bit for it to either crash or stabilize
	await new Promise((resolve) => setTimeout(resolve, 500));

	const isRunning = proc.exitCode === null;
	if (!isRunning) {
		console.error("MCP server exited early!");
		console.error("Exit code:", proc.exitCode);
		console.error("Stdout:", stdout);
		console.error("Stderr:", stderr);
	}

	proc.kill();
	await rm(projectDir, { recursive: true, force: true });
	await rm(configDir, { recursive: true, force: true });

	expect(isRunning).toBe(true);
});

test("jack mcp serve exposes tools without deploying", async () => {
	const projectDir = await mkdtemp(join(tmpdir(), "jack-mcp-test-"));
	const configDir = await mkdtemp(join(tmpdir(), "jack-config-"));
	const clientEnv = {
		...process.env,
		CI: "1",
		JACK_TELEMETRY_DISABLED: "1",
		JACK_CONFIG_DIR: configDir,
	};

	let client: Awaited<ReturnType<typeof openMcpTestClient>> | null = null;
	try {
		client = await openMcpTestClient({
			command: "bun",
			args: ["run", "src/index.ts", "mcp", "serve", "--project", projectDir],
			cwd: cliRoot,
			env: clientEnv,
		});

		await verifyMcpToolsAndResources(client.client);
		const projects = await callMcpListProjects(client.client, "local");
		if (!Array.isArray(projects)) {
			throw new Error("list_projects returned unexpected data");
		}
	} catch (err) {
		// Log stderr to help debug CI failures
		const stderr = client?.getStderr() ?? "(no client)";
		console.error("MCP test failed. Server stderr:", stderr);
		throw err;
	} finally {
		await client?.close();
		await rm(projectDir, { recursive: true, force: true });
		await rm(configDir, { recursive: true, force: true });
	}
});
