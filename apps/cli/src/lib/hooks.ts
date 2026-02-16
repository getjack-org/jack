import { existsSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import type { HookAction } from "../templates/types";
import { applyJsonWrite } from "./json-edit";
import { getSavedSecrets, saveSecrets } from "./secrets";
import { restoreTty } from "./tty";

/**
 * Read multi-line JSON input from stdin
 * User pastes JSON, then presses Enter on empty line to submit
 */
async function readMultilineJson(prompt: string): Promise<string> {
	// Ensure TTY is in a clean state before starting readline
	// This prevents conflicts with previous @clack/prompts selections
	restoreTty();

	console.error(prompt);
	console.error("(Paste JSON, then press Enter on empty line to submit)\n");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stderr,
	});

	const lines: string[] = [];

	return new Promise((resolve) => {
		rl.on("line", (line) => {
			// Empty line = submit (or skip if nothing entered)
			if (line.trim() === "") {
				rl.close();
				resolve(lines.join("\n"));
				return;
			}
			lines.push(line);
		});

		rl.on("close", () => {
			resolve(lines.join("\n"));
		});
	});
}

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
	celebrate?(title: string, lines: string[]): void;
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

// Re-export isCancel for consumers
export { isCancel } from "@clack/core";

// Unicode symbols (with ASCII fallbacks for non-unicode terminals)
const isUnicodeSupported =
	process.platform !== "win32" ||
	Boolean(process.env.CI) ||
	Boolean(process.env.WT_SESSION) ||
	process.env.TERM_PROGRAM === "vscode" ||
	process.env.TERM === "xterm-256color";

const S_RADIO_ACTIVE = isUnicodeSupported ? "●" : ">";
const S_RADIO_INACTIVE = isUnicodeSupported ? "○" : " ";

export interface SelectOption<T = string> {
	value: T;
	label: string;
	hint?: string;
}

/**
 * Clean select prompt with bullet-point style (no vertical bars)
 * Supports both:
 * - Number keys (1, 2, 3...) for immediate selection
 * - Arrow keys (up/down) + Enter for navigation-based selection
 *
 * @param message - The prompt message to display
 * @param options - Array of options (strings or {value, label, hint?} objects)
 * @returns The selected value, or symbol if cancelled
 */
export async function promptSelectValue<T>(
	message: string,
	options: Array<SelectOption<T> | string>,
): Promise<T | symbol> {
	const { SelectPrompt, isCancel } = await import("@clack/core");
	const pc = await import("picocolors");

	// Normalize options to {value, label} format
	const normalizedOptions = options.map((opt, index) => {
		if (typeof opt === "string") {
			return { value: opt as T, label: opt, key: String(index + 1) };
		}
		return { ...opt, key: String(index + 1) };
	});

	const prompt = new SelectPrompt({
		options: normalizedOptions,
		initialValue: normalizedOptions[0]?.value,
		render() {
			const title = `${message}\n`;
			const lines: string[] = [];

			for (let i = 0; i < normalizedOptions.length; i++) {
				const opt = normalizedOptions[i];
				const isActive = this.cursor === i;
				const num = `${i + 1}.`;

				if (isActive) {
					const hint = opt.hint ? pc.dim(` (${opt.hint})`) : "";
					lines.push(`${pc.green(S_RADIO_ACTIVE)} ${num} ${opt.label}${hint}`);
				} else {
					lines.push(`${pc.dim(S_RADIO_INACTIVE)} ${pc.dim(num)} ${pc.dim(opt.label)}`);
				}
			}

			return title + lines.join("\n");
		},
	});

	// Add number key support for immediate selection
	prompt.on("key", (char) => {
		if (!char) return;
		const num = Number.parseInt(char, 10);
		if (num >= 1 && num <= normalizedOptions.length) {
			prompt.value = normalizedOptions[num - 1]?.value;
			prompt.emit("submit");
		}
	});

	const result = await prompt.prompt();

	if (isCancel(result)) {
		return result;
	}

	return result as T;
}

/**
 * Simple select prompt for string options (returns index)
 * Supports both number keys (1, 2...) and arrow keys + Enter
 * Returns the selected option index (0-based) or -1 if cancelled
 */
export async function promptSelect(options: string[], message?: string): Promise<number> {
	const { isCancel } = await import("@clack/core");

	const result = await promptSelectValue(
		message ?? "",
		options.map((label, index) => ({ value: index, label })),
	);

	if (isCancel(result)) {
		return -1;
	}

	return result as number;
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

function isAccountAssociation(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	// Check direct format: { header, payload, signature }
	const obj = value as Record<string, unknown>;
	if (
		typeof obj.header === "string" &&
		typeof obj.payload === "string" &&
		typeof obj.signature === "string"
	) {
		return true;
	}
	// Check nested format from Farcaster: { accountAssociation: { header, payload, signature } }
	if (obj.accountAssociation && typeof obj.accountAssociation === "object") {
		const inner = obj.accountAssociation as Record<string, unknown>;
		return (
			typeof inner.header === "string" &&
			typeof inner.payload === "string" &&
			typeof inner.signature === "string"
		);
	}
	return false;
}

/**
 * Extract the accountAssociation object (handles both nested and flat formats)
 */
function extractAccountAssociation(
	value: unknown,
): { header: string; payload: string; signature: string } | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	// Direct format
	if (
		typeof obj.header === "string" &&
		typeof obj.payload === "string" &&
		typeof obj.signature === "string"
	) {
		return { header: obj.header, payload: obj.payload, signature: obj.signature };
	}
	// Nested format from Farcaster
	if (obj.accountAssociation && typeof obj.accountAssociation === "object") {
		const inner = obj.accountAssociation as Record<string, unknown>;
		if (
			typeof inner.header === "string" &&
			typeof inner.payload === "string" &&
			typeof inner.signature === "string"
		) {
			return { header: inner.header, payload: inner.payload, signature: inner.signature };
		}
	}
	return null;
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
		const onMissing = action.onMissing ?? "fail";

		if (action.source === "secret") {
			const result = await checkSecretExists(action.key, context.projectDir);
			if (result.exists) {
				// Found existing secret - show feedback for prompt/generate modes
				if (onMissing === "prompt" || onMissing === "generate") {
					ui.success(`Using saved ${action.key}`);
				}
				return true;
			}

			// Secret doesn't exist - handle based on onMissing mode
			if (!result.exists) {
				// Handle onMissing: "generate" - run command and save output
				if (onMissing === "generate" && action.generateCommand) {
					const message = action.message ?? `Generating ${action.key}...`;
					ui.info(message);

					try {
						const proc = Bun.spawn(["sh", "-c", action.generateCommand], {
							stdout: "pipe",
							stderr: "pipe",
						});
						await proc.exited;

						if (proc.exitCode === 0) {
							const stdout = await new Response(proc.stdout).text();
							const value = stdout.trim();
							if (value) {
								await saveSecrets([{ key: action.key, value, source: "generated" }]);
								ui.success(`Generated ${action.key}`);
								return true;
							}
						}
						ui.error(`Failed to generate ${action.key}`);
						return false;
					} catch {
						ui.error(`Failed to run: ${action.generateCommand}`);
						return false;
					}
				}

				// Handle onMissing: "prompt" - ask user for value
				if (onMissing === "prompt") {
					if (!interactive) {
						// Fall back to fail behavior in non-interactive mode
						const message = action.message ?? `Missing required secret: ${action.key}`;
						ui.error(message);
						ui.info(`Run: jack secrets add ${action.key}`);
						if (action.setupUrl) {
							ui.info(`Setup: ${action.setupUrl}`);
						}
						return false;
					}

					// Show setup info and go straight to prompt (URLs are clickable in most terminals)
					const promptMsg = action.promptMessage ?? `${action.key}:`;
					console.error("");
					if (action.message) {
						console.error(`  ${action.message}`);
					}
					if (action.setupUrl) {
						console.error(`  Get it at: \x1b[36m${action.setupUrl}\x1b[0m`);
					}
					console.error("");

					const { isCancel, text } = await import("@clack/prompts");
					const value = await text({ message: promptMsg });

					if (isCancel(value) || !value || !value.trim()) {
						return false;
					}

					await saveSecrets([{ key: action.key, value: value.trim(), source: "prompted" }]);
					ui.success(`Saved ${action.key}`);
					return true;
				}

				// Default: onMissing: "fail"
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

		let rawValue = "";

		// Use multi-line input for JSON validation (handles paste from Farcaster etc.)
		if (action.validate === "json" || action.validate === "accountAssociation") {
			rawValue = await readMultilineJson(action.message);
		} else if (action.secret) {
			// Use password() for sensitive input (masks the value)
			const { isCancel, password } = await import("@clack/prompts");
			const result = await password({ message: action.message });
			if (isCancel(result)) {
				return true;
			}
			rawValue = result;
		} else {
			const { isCancel, text } = await import("@clack/prompts");
			const result = await text({ message: action.message });
			if (isCancel(result)) {
				return true;
			}
			rawValue = result;
		}

		if (!rawValue.trim()) {
			return true;
		}

		let parsedInput: unknown = rawValue;
		if (action.validate === "json" || action.validate === "accountAssociation") {
			try {
				parsedInput = JSON.parse(rawValue);
			} catch {
				// Try normalizing whitespace (handles some multi-line paste issues)
				try {
					const normalized = rawValue.replace(/\n\s*/g, "");
					parsedInput = JSON.parse(normalized);
				} catch {
					ui.error("Invalid JSON input");
					return action.required ? false : true;
				}
			}
		}

		if (action.validate === "accountAssociation") {
			if (!isAccountAssociation(parsedInput)) {
				ui.error("Invalid accountAssociation JSON (expected header, payload, signature)");
				return action.required ? false : true;
			}
			// Extract the actual accountAssociation object (handles nested format from Farcaster)
			parsedInput = extractAccountAssociation(parsedInput);
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

			// Redeploy if deployAfter is set and we have a valid project directory
			if (action.deployAfter && context.projectDir) {
				const deployMsg = action.deployMessage || "Deploying...";
				ui.info(deployMsg);

				const proc = Bun.spawn(["wrangler", "deploy"], {
					cwd: context.projectDir,
					stdout: "ignore",
					stderr: "pipe",
				});
				await proc.exited;

				if (proc.exitCode === 0) {
					ui.success("Deployed");
				} else {
					const stderr = await new Response(proc.stderr).text();
					ui.warn(`Deploy failed: ${stderr.slice(0, 200)}`);
				}
			}
		}

		return true;
	},
	writeJson: async (action, context, options) => {
		const ui = options.output ?? noopOutput;
		const targetPath = resolveHookPath(action.path, context);
		const ok = await applyJsonWrite(targetPath, action.set, (value) =>
			substituteVars(value, context),
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
			// In non-interactive mode (MCP), stdout must NOT inherit because it would
			// write into the JSON-RPC stdio transport and corrupt the protocol.
			stdout: interactive ? "inherit" : "pipe",
			stderr: "inherit",
		});
		await proc.exited;
		return proc.exitCode === 0;
	},
	"stripe-setup": async (action, context, options) => {
		const ui = options.output ?? noopOutput;

		// Get Stripe API key from saved secrets
		const savedSecrets = await getSavedSecrets();
		const stripeKey = savedSecrets.STRIPE_SECRET_KEY;

		if (!stripeKey) {
			ui.error("Missing STRIPE_SECRET_KEY - run the secret prompt first");
			return false;
		}

		const message = action.message ?? "Setting up Stripe products and prices...";
		ui.info(message);

		// Helper to make Stripe API requests
		async function stripeRequest(
			method: string,
			endpoint: string,
			body?: Record<string, string>,
		): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
			const url = `https://api.stripe.com/v1${endpoint}`;
			const headers: Record<string, string> = {
				Authorization: `Bearer ${stripeKey}`,
			};

			const fetchOptions: RequestInit = { method, headers };
			if (body) {
				headers["Content-Type"] = "application/x-www-form-urlencoded";
				fetchOptions.body = new URLSearchParams(body).toString();
			}

			try {
				const response = await fetch(url, fetchOptions);
				const data = (await response.json()) as Record<string, unknown>;

				if (!response.ok) {
					const error = data.error as { message?: string } | undefined;
					return { ok: false, error: error?.message ?? "Stripe API error" };
				}
				return { ok: true, data };
			} catch (err) {
				return { ok: false, error: String(err) };
			}
		}

		// Search for existing price by lookup_key
		async function findPriceByLookupKey(lookupKey: string): Promise<string | null> {
			const result = await stripeRequest(
				"GET",
				`/prices?lookup_keys[]=${encodeURIComponent(lookupKey)}&active=true`,
			);
			if (result.ok && result.data) {
				const prices = result.data.data as Array<{ id: string }>;
				if (prices.length > 0) {
					return prices[0].id;
				}
			}
			return null;
		}

		// Create a new product
		async function createProduct(name: string, description?: string): Promise<string | null> {
			const body: Record<string, string> = { name };
			if (description) {
				body.description = description;
			}
			const result = await stripeRequest("POST", "/products", body);
			if (result.ok && result.data) {
				return result.data.id as string;
			}
			return null;
		}

		// Create a new price with lookup_key
		async function createPrice(
			productId: string,
			amount: number,
			interval: "month" | "year",
			lookupKey: string,
		): Promise<string | null> {
			const result = await stripeRequest("POST", "/prices", {
				product: productId,
				unit_amount: String(amount),
				currency: "usd",
				"recurring[interval]": interval,
				lookup_key: lookupKey,
			});
			if (result.ok && result.data) {
				return result.data.id as string;
			}
			return null;
		}

		const secretsToSave: Array<{ key: string; value: string; source: string }> = [];

		for (const plan of action.plans) {
			const lookupKey = `jack_${plan.name.toLowerCase()}_${plan.interval}`;

			// Check if price key already exists in secrets (manual override)
			if (savedSecrets[plan.priceKey]) {
				ui.success(`Using existing ${plan.priceKey}`);
				continue;
			}

			// Search for existing price by lookup_key
			ui.info(`Checking for existing ${plan.name} price...`);
			let priceId = await findPriceByLookupKey(lookupKey);

			if (priceId) {
				ui.success(`Found existing ${plan.name} price: ${priceId}`);
			} else {
				// Create product and price
				ui.info(`Creating ${plan.name} product and price...`);

				const productId = await createProduct(plan.name, plan.description ?? `${plan.name} plan`);
				if (!productId) {
					ui.error(`Failed to create ${plan.name} product`);
					return false;
				}

				priceId = await createPrice(productId, plan.amount, plan.interval, lookupKey);
				if (!priceId) {
					ui.error(`Failed to create ${plan.name} price`);
					return false;
				}

				ui.success(`Created ${plan.name}: ${priceId}`);
			}

			secretsToSave.push({
				key: plan.priceKey,
				value: priceId,
				source: "stripe-setup",
			});
		}

		// Save all price IDs to secrets
		if (secretsToSave.length > 0) {
			await saveSecrets(secretsToSave);
			ui.success("Saved Stripe price IDs to secrets");
		}

		return true;
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

export interface HookResult {
	success: boolean;
	hadInteractiveActions: boolean;
}

/**
 * Run a list of hook actions
 * Returns success status and whether any interactive actions were executed
 */
export async function runHook(
	actions: HookAction[],
	context: HookContext,
	options?: HookOptions,
): Promise<HookResult> {
	const interactive = options?.interactive !== false;
	// Track if we had any interactive actions (prompt, pause) that ran
	const interactiveActionTypes = ["prompt", "pause"];
	let hadInteractiveActions = false;

	for (const action of actions) {
		// Check if this is an interactive action that will actually run
		if (interactive && interactiveActionTypes.includes(action.action)) {
			hadInteractiveActions = true;
		}
		const shouldContinue = await executeAction(action, context, options);
		if (!shouldContinue) {
			return { success: false, hadInteractiveActions };
		}
	}
	return { success: true, hadInteractiveActions };
}
