import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookAction } from "../templates/types";
import { applyJsonWrite } from "./json-edit";
import { getSavedSecrets } from "./secrets";
import { restoreTty } from "./tty";

export interface HookContext {
	domain?: string; // deployed domain (e.g., "my-app.username.workers.dev")
	url?: string; // full deployed URL
	projectName?: string;
	projectDir?: string; // absolute path to project directory
}

export interface HookOutput {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
	success(message: string): void;
	box(title: string, lines: string[]): void;
}

export interface HookOptions {
	interactive?: boolean;
	output?: HookOutput;
}

const noopOutput: HookOutput = {
	info() {},
	warn() {},
	error() {},
	success() {},
	box() {},
};

/**
 * Hook schema quick reference (interactive behavior + fields)
 *
 * - message: { text } -> prints info
 * - box: { title, lines } -> prints boxed text
 * - url: { url, label?, open?, prompt? } -> prints link; optional open prompt
 * - clipboard: { text, message? } -> copy to clipboard (prints in non-interactive)
 * - pause: { message? } -> waits for enter (skipped in non-interactive)
 * - require: { source, key, message?, setupUrl? } -> validates secret/env
 * - shell: { command, cwd?, message? } -> runs shell command
 * - prompt: { message, validate?, required?, successMessage?, writeJson? } -> input + optional JSON update
 * - writeJson: { path, set, successMessage? } -> JSON update (runs in non-interactive)
 */

/**
 * Prompt user with numbered options (Claude Code style)
 * Returns the selected option index (0-based) or -1 if cancelled
 */
export async function promptSelect(options: string[]): Promise<number> {
	// Display options
	for (let i = 0; i < options.length; i++) {
		console.error(`  ${i + 1}. ${options[i]}`);
	}
	console.error("");
	console.error("  Esc to skip");

	// Read single keypress
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
	}
	process.stdin.resume();

	return new Promise((resolve) => {
		const onData = (key: Buffer) => {
			const char = key.toString();

			// Esc or q to cancel
			if (char === "\x1b" || char === "q") {
				cleanup();
				resolve(-1);
				return;
			}

			// Number keys
			const num = Number.parseInt(char, 10);
			if (num >= 1 && num <= options.length) {
				cleanup();
				resolve(num - 1);
				return;
			}
		};

		const cleanup = () => {
			process.stdin.removeListener("data", onData);
			restoreTty();
		};

		process.stdin.on("data", onData);
	});
}

/**
 * Wait for user to press Enter
 */
async function waitForEnter(message?: string): Promise<void> {
	console.error(message ?? "Press Enter to continue...");

	return new Promise((resolve) => {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();

		const onData = (key: Buffer) => {
			const char = key.toString();
			// Enter, Space, or any key to continue
			if (char === "\r" || char === "\n" || char === " ") {
				process.stdin.removeListener("data", onData);
				restoreTty();
				resolve();
			}
			// Esc to skip
			if (char === "\x1b") {
				process.stdin.removeListener("data", onData);
				restoreTty();
				resolve();
			}
		};

		process.stdin.on("data", onData);
	});
}

/**
 * Substitute {{variable}} placeholders in a string
 */
function substituteVars(str: string, context: HookContext): string {
	return str
		.replace(/\{\{domain\}\}/g, context.domain ?? "")
		.replace(/\{\{url\}\}/g, context.url ?? "")
		.replace(/\{\{name\}\}/g, context.projectName ?? "");
}

function resolveHookPath(filePath: string, context: HookContext): string {
	if (filePath.startsWith("/")) {
		return filePath;
	}
	if (!context.projectDir) {
		return filePath;
	}
	return join(context.projectDir, filePath);
}

function isAccountAssociation(value: unknown): value is { header: string; payload: string; signature: string } {
	if (!value || typeof value !== "object") return false;
	const obj = value as { header?: unknown; payload?: unknown; signature?: unknown };
	return (
		typeof obj.header === "string" &&
		typeof obj.payload === "string" &&
		typeof obj.signature === "string"
	);
}

/**
 * Open a URL in the default browser
 */
async function openBrowser(url: string): Promise<void> {
	const { platform } = process;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";

	const proc = Bun.spawn([command, url], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await proc.exited;
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text: string): Promise<boolean> {
	const { platform } = process;
	let command: string[];

	if (platform === "darwin") {
		command = ["pbcopy"];
	} else if (platform === "win32") {
		command = ["clip"];
	} else {
		command = ["xclip", "-selection", "clipboard"];
	}

	try {
		const proc = Bun.spawn(command, {
			stdin: new TextEncoder().encode(text),
			stdout: "ignore",
			stderr: "ignore",
		});
		await proc.exited;
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check if a secret exists in saved secrets or project .env
 */
async function checkSecretExists(
	secret: string,
	projectDir?: string,
): Promise<{ exists: boolean; source?: string }> {
	// Check saved secrets first
	const saved = await getSavedSecrets();
	if (saved[secret]) {
		return { exists: true, source: "saved" };
	}

	// Check project .env
	if (projectDir) {
		const envPath = join(projectDir, ".env");
		if (existsSync(envPath)) {
			const content = await Bun.file(envPath).text();
			const regex = new RegExp(`^${secret}=.+`, "m");
			if (regex.test(content)) {
				return { exists: true, source: ".env" };
			}
		}
	}

	return { exists: false };
}

/**
 * Check if an env var exists in project .env
 */
async function checkEnvExists(env: string, projectDir?: string): Promise<boolean> {
	if (!projectDir) return false;

	const envPath = join(projectDir, ".env");
	if (!existsSync(envPath)) return false;

	const content = await Bun.file(envPath).text();
	const regex = new RegExp(`^${env}=.+`, "m");
	return regex.test(content);
}

/**
 * Execute a single hook action
 * Returns true if should continue, false if should abort
 */
type ActionHandler<T extends HookAction["action"]> = (
	action: Extract<HookAction, { action: T }>,
	context: HookContext,
	options: HookOptions,
) => Promise<boolean>;

const actionHandlers: {
	[T in HookAction["action"]]: ActionHandler<T>;
} = {
	message: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		ui.info(substituteVars(action.text, context));
		return true;
	},
	box: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const title = substituteVars(action.title, context);
		const lines = action.lines.map((line) => substituteVars(line, context));
		ui.box(title, lines);
		return true;
	},
	url: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const interactive = options.interactive !== false;
		const url = substituteVars(action.url, context);
		const label = action.label ?? "Link";
		if (!interactive) {
			ui.info(`${label}: ${url}`);
			return true;
		}
		console.error("");
		console.error(`  ${label}: \x1b[36m${url}\x1b[0m`);

		if (action.open) {
			ui.info(`Opening: ${url}`);
			await openBrowser(url);
			return true;
		}

		if (action.prompt !== false) {
			console.error("");
			const choice = await promptSelect(["Open in browser", "Skip"]);
			if (choice === 0) {
				await openBrowser(url);
				ui.success("Opened in browser");
			}
		}
		return true;
	},
	clipboard: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const interactive = options.interactive !== false;
		const text = substituteVars(action.text, context);
		if (!interactive) {
			ui.info(text);
			return true;
		}
		const success = await copyToClipboard(text);
		if (success) {
			const message = action.message ?? "Copied to clipboard";
			ui.success(message);
		} else {
			ui.warn("Could not copy to clipboard");
		}
		return true;
	},
	pause: async (action, _context, options) => {
		const interactive = options.interactive !== false;
		if (!interactive) {
			return true;
		}
		await waitForEnter(action.message);
		return true;
	},
	require: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const interactive = options.interactive !== false;
		if (action.source === "secret") {
			const result = await checkSecretExists(action.key, context.projectDir);
			if (!result.exists) {
				const message = action.message ?? `Missing required secret: ${action.key}`;
				ui.error(message);
				ui.info(`Run: jack secrets add ${action.key}`);

				if (action.setupUrl) {
					if (interactive) {
						console.error("");
						const choice = await promptSelect(["Open setup page", "Skip"]);
						if (choice === 0) {
							await openBrowser(action.setupUrl);
						}
					} else {
						ui.info(`Setup: ${action.setupUrl}`);
					}
				}
				return false;
			}
			return true;
		}

		const exists = await checkEnvExists(action.key, context.projectDir);
		if (!exists) {
			const message = action.message ?? `Missing required env var: ${action.key}`;
			ui.error(message);
			if (action.setupUrl) {
				ui.info(`Setup: ${action.setupUrl}`);
			}
			return false;
		}
		return true;
	},
	prompt: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const interactive = options.interactive !== false;
		if (!interactive) {
			return true;
		}

		const { input } = await import("@inquirer/prompts");

		let rawValue = "";
		try {
			rawValue = await input({ message: action.message });
		} catch (err) {
			if (err instanceof Error && err.name === "ExitPromptError") {
				return true;
			}
			throw err;
		}

		if (!rawValue.trim()) {
			return true;
		}

		let parsedInput: unknown = rawValue;
		if (action.validate === "json" || action.validate === "accountAssociation") {
			try {
				parsedInput = JSON.parse(rawValue);
			} catch {
				ui.error("Invalid JSON input");
				return action.required ? false : true;
			}
		}

		if (action.validate === "accountAssociation" && !isAccountAssociation(parsedInput)) {
			ui.error("Invalid accountAssociation JSON (expected header, payload, signature)");
			return action.required ? false : true;
		}

		if (action.writeJson) {
			const targetPath = resolveHookPath(action.writeJson.path, context);
			const ok = await applyJsonWrite(
				targetPath,
				action.writeJson.set,
				(value) => substituteVars(value, context),
				parsedInput,
			);
			if (!ok) {
				ui.error(`Invalid JSON file: ${targetPath}`);
				return action.required ? false : true;
			}
			if (action.successMessage) {
				ui.success(substituteVars(action.successMessage, context));
			}
		}

		return true;
	},
	writeJson: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const targetPath = resolveHookPath(action.path, context);
		const ok = await applyJsonWrite(
			targetPath,
			action.set,
			(value) => substituteVars(value, context),
		);
		if (!ok) {
			ui.error(`Invalid JSON file: ${targetPath}`);
			return false;
		}
		if (action.successMessage) {
			ui.success(substituteVars(action.successMessage, context));
		}
		return true;
	},
	shell: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const interactive = options.interactive !== false;
		const command = substituteVars(action.command, context);
		if (action.message) {
			ui.info(action.message);
		}
		const cwd = action.cwd === "project" ? context.projectDir : undefined;
		// Resume stdin in case previous prompts paused it
		if (interactive) {
			process.stdin.resume();
		}
		const proc = Bun.spawn(["sh", "-c", command], {
			cwd,
			stdin: interactive ? "inherit" : "ignore",
			stdout: "inherit",
			stderr: "inherit",
		});
		await proc.exited;
		return proc.exitCode === 0;
	},
};

async function executeAction(
	action: HookAction,
	context: HookContext,
	options?: HookOptions,
): Promise<boolean> {
	const handler = actionHandlers[action.action] as (
		action: HookAction,
		context: HookContext,
		options: HookOptions,
	) => Promise<boolean>;
	return handler(action, context, options ?? {});
}

/**
 * Run a list of hook actions
 * Returns true if all succeeded, false if any failed (for preDeploy checks)
 */
export async function runHook(
	actions: HookAction[],
	context: HookContext,
	options?: HookOptions,
): Promise<boolean> {
	for (const action of actions) {
		const shouldContinue = await executeAction(action, context, options);
		if (!shouldContinue) {
			return false;
		}
	}
	return true;
}
