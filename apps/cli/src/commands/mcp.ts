import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	APP_MCP_CONFIGS,
	getAppDisplayName,
	installMcpConfigToApp,
	isAppInstalled,
} from "../lib/mcp-config.ts";
import { error, info, item, success } from "../lib/output.ts";
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

	if (subcommand === "install") {
		await installMcpConfig();
		return;
	}

	if (subcommand === "context") {
		await outputProjectContext();
		return;
	}

	error(
		"Unknown subcommand. Use: jack mcp serve, jack mcp install, jack mcp test, or jack mcp context",
	);
	info("Usage:");
	info("  jack mcp serve [--project /path] [--debug]  Start MCP server");
	info("  jack mcp install                            Install/repair MCP config for AI agents");
	info("  jack mcp test                               Test MCP server connectivity");
	info("  jack mcp context                            Output project context for hooks");
	process.exit(1);
}

/**
 * Install or repair MCP configuration for all detected apps
 */
async function installMcpConfig(): Promise<void> {
	info("Installing jack MCP server configuration...\n");

	const installed: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];

	for (const appId of Object.keys(APP_MCP_CONFIGS)) {
		const displayName = getAppDisplayName(appId);

		if (!isAppInstalled(appId)) {
			skipped.push(displayName);
			continue;
		}

		try {
			const result = await installMcpConfigToApp(appId);
			if (result) {
				installed.push(displayName);
			} else {
				failed.push(displayName);
			}
		} catch {
			failed.push(displayName);
		}
	}

	// Report results
	if (installed.length > 0) {
		success(`Installed to ${installed.length} app(s):`);
		for (const app of installed) {
			item(`  ${app}`);
		}
	}

	if (skipped.length > 0) {
		info("\nSkipped (not installed):");
		for (const app of skipped) {
			item(`  ${app}`);
		}
	}

	if (failed.length > 0) {
		error("\nFailed to install:");
		for (const app of failed) {
			item(`  ${app}`);
		}
	}

	if (installed.length > 0) {
		info("\nRestart your AI agent (Claude Code, Claude Desktop) to use jack MCP tools.");
	} else if (failed.length === 0 && skipped.length > 0) {
		info("\nNo supported AI agents detected. Install Claude Code or Claude Desktop first.");
	}
}

/**
 * Parse wrangler config (jsonc or toml) and extract binding info.
 * Returns null on any failure — never blocks session start.
 */
async function parseWranglerBindings(cwd: string): Promise<{
	databases: string[];
	buckets: string[];
	vectorize: string[];
	ai: boolean;
	kv: string[];
} | null> {
	try {
		const { findWranglerConfig } = await import("../lib/wrangler-config.ts");
		const { parseJsonc } = await import("../lib/jsonc.ts");
		const configPath = findWranglerConfig(cwd);
		if (!configPath) return null;

		const content = await readFile(configPath, "utf-8");

		let config: Record<string, unknown> | null = null;

		if (configPath.endsWith(".toml")) {
			// For toml, just check for key patterns — not worth a full parser here
			return {
				databases: content.includes("d1_databases") ? ["(see wrangler.toml)"] : [],
				buckets: content.includes("r2_buckets") ? ["(see wrangler.toml)"] : [],
				vectorize: content.includes("vectorize") ? ["(see wrangler.toml)"] : [],
				ai: content.includes("[ai]"),
				kv: content.includes("kv_namespaces") ? ["(see wrangler.toml)"] : [],
			};
		}

		config = parseJsonc<Record<string, unknown>>(content);
		if (!config) return null;

		const databases =
			(config.d1_databases as { database_name?: string; binding?: string }[])?.map(
				(d) => d.database_name || d.binding || "unknown",
			) ?? [];
		const buckets =
			(config.r2_buckets as { bucket_name?: string; binding?: string }[])?.map(
				(b) => b.bucket_name || b.binding || "unknown",
			) ?? [];
		const vectorize =
			(config.vectorize as { index_name?: string; binding?: string }[])?.map(
				(v) => v.index_name || v.binding || "unknown",
			) ?? [];
		const ai = !!config.ai;
		const kv =
			(config.kv_namespaces as { binding?: string }[])?.map((k) => k.binding || "unknown") ?? [];

		return { databases, buckets, vectorize, ai, kv };
	} catch {
		return null;
	}
}

async function outputProjectContext(): Promise<void> {
	try {
		const cwd = process.cwd();
		const { readProjectLink, readTemplateMetadata } = await import("../lib/project-link.ts");
		const link = await readProjectLink(cwd);

		// Silent exit if not a jack project — don't leak into non-jack sessions
		if (!link) return;

		// Fire-and-forget telemetry (no latency added)
		const { track, Events } = await import("../lib/telemetry.ts");
		track(Events.HOOK_SESSION_CONTEXT, {
			deploy_mode: link.deploy_mode,
		});

		const sections: string[] = [];

		const { getProjectNameFromDir } = await import("../lib/storage/index.ts");
		let name = "unknown";
		try {
			name = await getProjectNameFromDir(cwd);
		} catch {
			// No wrangler config
		}

		// --- Section 1: Project identity ---
		const lines = [`# Jack Project: ${name}`, ""];
		if (link.deploy_mode === "managed") {
			const { buildManagedUrl } = await import("../lib/project-link.ts");
			const url = await buildManagedUrl(name, link.owner_username, cwd);
			lines.push(`- **URL:** ${url}`);
		}
		lines.push(`- **Project ID:** ${link.project_id}`);
		lines.push(
			`- **Deploy mode:** ${link.deploy_mode === "managed" ? "Jack Cloud (managed)" : "BYO (bring your own Cloudflare account)"}`,
		);

		// Template origin
		const templateMeta = await readTemplateMetadata(cwd);
		if (templateMeta) {
			lines.push(`- **Template:** ${templateMeta.name} (${templateMeta.type})`);
		}

		// --- Section 2: Detected services ---
		const bindings = await parseWranglerBindings(cwd);
		if (bindings) {
			const services: string[] = [];
			if (bindings.databases.length > 0)
				services.push(`D1 databases: ${bindings.databases.join(", ")}`);
			if (bindings.buckets.length > 0) services.push(`R2 storage: ${bindings.buckets.join(", ")}`);
			if (bindings.vectorize.length > 0)
				services.push(`Vectorize indexes: ${bindings.vectorize.join(", ")}`);
			if (bindings.kv.length > 0) services.push(`KV namespaces: ${bindings.kv.join(", ")}`);
			if (bindings.ai) services.push("AI (Workers AI)");

			if (services.length > 0) {
				lines.push("");
				lines.push("### Services");
				for (const svc of services) {
					lines.push(`- ${svc}`);
				}
			}
		}

		// --- Section 3: Mode-specific guidance ---
		lines.push("");
		lines.push("## How to work with this project");
		lines.push("");

		if (link.deploy_mode === "managed") {
			lines.push("This is a **Jack Cloud** project. All infrastructure is managed by jack.");
			lines.push("");
			lines.push("- Deploy: `mcp__jack__deploy_project` or `jack ship`");
			lines.push("- Database: `mcp__jack__execute_sql` or `jack services db query`");
			lines.push("- Logs: `mcp__jack__tail_logs` or `jack logs`");
			lines.push("- Status: `mcp__jack__get_project_status` or `jack info`");
			lines.push("");
			lines.push(
				"**Do NOT run `wrangler` commands.** This project uses Jack Cloud — there are no local Cloudflare credentials.",
			);
			lines.push(
				"The `wrangler.jsonc` file is only used for local dev and build configuration, not for deployment.",
			);
		} else {
			lines.push("This is a **BYO** (Bring Your Own) project deployed to your Cloudflare account.");
			lines.push("");
			lines.push("- Deploy: `mcp__jack__deploy_project` or `jack ship`");
			lines.push("- Logs: `mcp__jack__tail_logs` or `jack logs`");
			lines.push("- Status: `mcp__jack__get_project_status` or `jack info`");
			lines.push("");
			lines.push(
				"Prefer `mcp__jack__*` tools or `jack` CLI over raw `wrangler` commands for consistency.",
			);
		}

		lines.push("");
		lines.push(
			'To fork/clone a project: `mcp__jack__create_project` with `template: "username/slug"` or `template: "my-project"`.',
		);
		lines.push("");
		lines.push(
			"**Always prefer `mcp__jack__*` tools over CLI commands or wrangler** — they are cloud-aware and work in all deploy modes.",
		);
		sections.push(lines.join("\n"));

		console.log(sections.join("\n\n---\n\n"));
	} catch {
		// Silent on failure — never break the session
	}
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
