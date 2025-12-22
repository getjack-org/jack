#!/usr/bin/env bun
// Usage: bun run scripts/integration.ts
// Optional env: JACK_BIN, JACK_ARGS, JACK_IT_TEMPLATE, JACK_IT_PROJECT, JACK_IT_ROOT, JACK_IT_RUN_ID, JACK_IT_LOG, JACK_IT_CLEANUP, JACK_IT_KEEP_REGISTRY
// Flags: --cleanup, --no-log, --keep-registry
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Step = {
	name: string;
	run: () => Promise<void>;
};

type CommandResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
};

class CommandError extends Error {
	exitCode: number | null;
	stdout: string;
	stderr: string;

	constructor(message: string, result: CommandResult) {
		super(message);
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runId =
	process.env.JACK_IT_RUN_ID ??
	`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const projectName = (process.env.JACK_IT_PROJECT ?? `jack-it-${runId}`).toLowerCase();
const template = process.env.JACK_IT_TEMPLATE ?? "api";
const workRoot = resolve(process.env.JACK_IT_ROOT ?? join(tmpdir(), "jack-it"));
const projectDir = join(workRoot, projectName);

const jackArgsRaw = (process.env.JACK_ARGS ?? "").trim();
const argvFlags = new Set(process.argv.slice(2));
const cleanupEnabled = argvFlags.has("--cleanup") || process.env.JACK_IT_CLEANUP === "1";
const keepRegistry = argvFlags.has("--keep-registry") || process.env.JACK_IT_KEEP_REGISTRY === "1";
const logDisabled = argvFlags.has("--no-log") || process.env.JACK_IT_LOG === "0";
const logPath = logDisabled
	? null
	: (process.env.JACK_IT_LOG ?? join(repoRoot, "scripts", "integration.log"));
const logStream = logPath ? createWriteStream(logPath, { flags: "w" }) : null;

const jackCommand = resolveJackCommand();
const jackBaseArgs = resolveJackArgs(jackCommand, jackArgsRaw);

const jackEnv = {
	...process.env,
	CI: "1",
	JACK_TELEMETRY_DISABLED: "1",
};

const state = {
	projectCreated: false,
	projectDeployed: false,
	projectRemoved: false,
};

function formatCommand(command: string, args: string[]): string {
	return [command, ...args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))].join(" ");
}

function writeLog(message: string): void {
	logStream?.write(message);
}

if (logPath) {
	writeLog(`Integration run ${new Date().toISOString()}\n`);
	writeLog(`Log path: ${logPath}\n`);
	writeLog(`CLI: ${formatCommand(jackCommand, jackBaseArgs)}\n`);
}

function resolveJackCommand(): string {
	if (process.env.JACK_BIN) {
		return process.env.JACK_BIN;
	}

	const detected = findOnPath("jack");
	if (detected) {
		return detected;
	}

	return "bun";
}

function resolveJackArgs(command: string, rawArgs: string): string[] {
	if (rawArgs.length > 0) {
		return rawArgs.split(/\s+/).filter(Boolean);
	}

	const commandBase = basename(command);
	const isBun = commandBase === "bun" || commandBase === "bun.exe";
	if (!isBun) {
		return [];
	}

	return ["run", join(repoRoot, "src/index.ts")];
}

function findOnPath(commandName: string): string | null {
	const pathVar = process.env.PATH;
	if (!pathVar) return null;

	const isWindows = process.platform === "win32";
	const suffixes = isWindows ? [".exe", ".cmd", ".bat", ""] : [""];

	for (const dir of pathVar.split(delimiter)) {
		for (const suffix of suffixes) {
			const candidate = join(dir, `${commandName}${suffix}`);
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}

	return null;
}

async function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
	return await new Promise((resolve, reject) => {
		writeLog(`\n$ ${formatCommand(command, args)}\n`);
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			writeLog(text);
			process.stdout.write(text);
		});

		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			writeLog(text);
			process.stderr.write(text);
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			const result = { exitCode: code, stdout, stderr };
			if (code === 0) {
				resolve(result);
			} else {
				reject(new CommandError(`Command failed: ${formatCommand(command, args)}`, result));
			}
		});
	});
}

async function runJack(args: string[], options: { cwd?: string } = {}): Promise<CommandResult> {
	return await runCommand(jackCommand, [...jackBaseArgs, ...args], {
		cwd: options.cwd,
		env: jackEnv,
	});
}

function cleanupHints(): string[] {
	const hints: string[] = [];
	if (state.projectDeployed) {
		hints.push(`jack down ${projectName} --force`);
	}
	if (state.projectCreated && existsSync(projectDir)) {
		hints.push(`rm -rf ${projectDir}`);
		hints.push(`jack projects remove ${projectName}`);
		hints.push("jack projects cleanup (interactive)");
	}
	return hints;
}

async function attemptCleanup(reason: string): Promise<void> {
	if (!cleanupEnabled) return;

	console.error(`\nCleanup (${reason}) starting...`);
	writeLog(`\n==> Cleanup (${reason})\n`);

	if (state.projectDeployed || state.projectCreated || existsSync(projectDir)) {
		try {
			await runJack(["down", projectName, "--force"]);
			state.projectDeployed = false;
		} catch (error) {
			console.error("Cleanup: jack down failed");
			if (error instanceof Error) {
				console.error(error.message);
			}
		}
	}

	if (existsSync(projectDir)) {
		try {
			const resolvedProjectDir = resolve(projectDir);
			const rel = relative(workRoot, resolvedProjectDir);
			if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
				await rm(resolvedProjectDir, { recursive: true, force: true });
				state.projectRemoved = true;
			}
		} catch (error) {
			console.error("Cleanup: failed to remove local directory");
			if (error instanceof Error) {
				console.error(error.message);
			}
		}
	}

	if (!keepRegistry) {
		try {
			await runJack(["projects", "remove", projectName, "--yes"]);
		} catch (error) {
			console.error("Cleanup: failed to remove registry entry");
			if (error instanceof Error) {
				console.error(error.message);
			}
		}
	}
}

async function runStep(step: Step): Promise<void> {
	console.log(`\n==> ${step.name}`);
	writeLog(`\n==> ${step.name}\n`);
	try {
		await step.run();
	} catch (error) {
		console.error(`\nStep failed: ${step.name}`);
		if (error instanceof CommandError) {
			if (error.stderr.trim()) {
				console.error("\nCaptured stderr:");
				console.error(error.stderr.trim());
			}
		} else if (error instanceof Error) {
			console.error(error.message);
		} else {
			console.error(String(error));
		}

		await attemptCleanup(`step "${step.name}" failed`);

		const hints = cleanupHints();
		if (hints.length > 0) {
			console.error("\nCleanup suggestions:");
			for (const hint of hints) {
				console.error(`- ${hint}`);
			}
		}

		if (logPath) {
			console.error(`\nLog: ${logPath}`);
		}

		logStream?.end();
		process.exit(1);
	}
}

function parseMcpToolResult(toolResult: {
	content?: Array<{ type: string; text?: string }>;
}): unknown {
	const toolText = toolResult.content?.[0]?.type === "text" ? toolResult.content[0].text : null;
	if (!toolText) {
		throw new Error("MCP tool response missing text content");
	}

	const parsed = JSON.parse(toolText);
	if (!parsed.success) {
		const message = parsed.error?.message ?? "unknown error";
		throw new Error(`MCP tool failed: ${message}`);
	}

	return parsed.data;
}

async function connectMcp(expectedDeployed: boolean | null): Promise<void> {
	const transport = new StdioClientTransport({
		command: jackCommand,
		args: [...jackBaseArgs, "mcp", "serve", "--project", projectDir],
		env: jackEnv,
		cwd: repoRoot,
		stderr: "pipe",
	});

	let stderrBuffer = "";
	transport.stderr?.on("data", (chunk) => {
		stderrBuffer += chunk.toString();
	});

	const client = new Client({ name: "jack-integration", version: "0.1.0" });

	try {
		await client.connect(transport);
		const tools = await client.listTools();
		if (!tools.tools?.length) {
			throw new Error("MCP server reported no tools");
		}

		const resources = await client.listResources();
		if (!resources.resources?.length) {
			throw new Error("MCP server reported no resources");
		}

		await client.readResource({ uri: "agents://context" });

		const listResult = await client.callTool({
			name: "list_projects",
			arguments: { filter: "local" },
		});
		const listData = parseMcpToolResult(listResult);

		if (!Array.isArray(listData) || !listData.some((proj) => proj?.name === projectName)) {
			throw new Error("MCP list_projects did not include the test project");
		}

		const statusResult = await client.callTool({
			name: "get_project_status",
			arguments: { name: projectName },
		});
		const statusData = parseMcpToolResult(statusResult) as {
			deployed?: boolean;
			local?: boolean;
			name?: string;
		};

		if (statusData?.name !== projectName) {
			throw new Error("MCP get_project_status returned unexpected project");
		}
		if (expectedDeployed !== null && statusData?.deployed !== expectedDeployed) {
			throw new Error(`MCP get_project_status expected deployed=${String(expectedDeployed)}`);
		}
		if (statusData?.local !== true) {
			throw new Error("MCP get_project_status expected local=true");
		}

		console.log(`MCP OK: tools=${tools.tools.length} resources=${resources.resources.length}`);
	} catch (error) {
		if (stderrBuffer.trim()) {
			console.error("\nMCP server stderr:");
			console.error(stderrBuffer.trim());
		}
		throw error;
	} finally {
		await client.close();
		await transport.close();
	}
}

const steps: Step[] = [
	{
		name: `Create + deploy (${projectName}, template=${template})`,
		run: async () => {
			await mkdir(workRoot, { recursive: true });
			await runJack(["new", projectName, "--template", template], { cwd: workRoot });
			state.projectCreated = true;
			state.projectDeployed = true;
		},
	},
	{
		name: "Connect to MCP + list tools/resources",
		run: async () => {
			await connectMcp(true);
		},
	},
	{
		name: "Undeploy",
		run: async () => {
			await runJack(["down", projectName, "--force"]);
			state.projectDeployed = false;
		},
	},
	{
		name: "Verify MCP status after undeploy",
		run: async () => {
			await connectMcp(false);
		},
	},
	{
		name: "Remove registry entry",
		run: async () => {
			if (keepRegistry) return;
			await runJack(["projects", "remove", projectName, "--yes"]);
		},
	},
	{
		name: "Remove local project directory",
		run: async () => {
			const resolvedProjectDir = resolve(projectDir);
			const rel = relative(workRoot, resolvedProjectDir);
			if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`Refusing to delete outside work root: ${resolvedProjectDir}`);
			}
			await rm(resolvedProjectDir, { recursive: true, force: true });
			state.projectRemoved = true;
		},
	},
];

for (const step of steps) {
	await runStep(step);
}

console.log("\nIntegration flow complete.");
console.log(`Project name: ${projectName}`);
if (!state.projectRemoved) {
	console.log("Project directory was not removed.");
}
if (logPath) {
	console.log(`Log: ${logPath}`);
}
logStream?.end();
