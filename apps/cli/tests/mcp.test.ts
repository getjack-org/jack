import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
	callMcpListProjects,
	openMcpTestClient,
	verifyMcpToolsAndResources,
} from "../src/mcp/test-utils.ts";

const cliRoot = fileURLToPath(new URL("../", import.meta.url));

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
