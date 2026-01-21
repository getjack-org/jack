/**
 * jack secrets - Manage project secrets securely
 *
 * Secrets are stored in Cloudflare and never written to disk.
 * For managed projects: uses jack cloud control plane.
 * For BYO projects: uses wrangler secret commands.
 */

import { password as passwordPrompt } from "@clack/prompts";
import { isCancel } from "../lib/hooks.ts";
import { $ } from "bun";
import { getControlApiUrl } from "../lib/control-plane.ts";
import { JackError, JackErrorCode } from "../lib/errors.ts";
import { error, info, output, success, warn } from "../lib/output.ts";
import { type LocalProjectLink, readProjectLink } from "../lib/project-link.ts";
import { getProjectNameFromDir } from "../lib/storage/index.ts";

interface SecretsOptions {
	project?: string;
}

export default async function secrets(
	subcommand?: string,
	args: string[] = [],
	options: SecretsOptions = {},
): Promise<void> {
	if (!subcommand) {
		return showHelp();
	}

	switch (subcommand) {
		case "set":
		case "add":
			return await setSecret(args, options);
		case "list":
		case "ls":
			return await listSecrets(options);
		case "rm":
		case "remove":
		case "delete":
			return await removeSecret(args, options);
		default:
			error(`Unknown subcommand: ${subcommand}`);
			info("Available: set, list, rm");
			process.exit(1);
	}
}

function showHelp(): void {
	console.error("");
	info("jack secrets - Manage project secrets");
	console.error("");
	console.error("Commands:");
	console.error("  set <KEY>           Set a secret (interactive prompt)");
	console.error("  set KEY=VALUE       Set a secret (warning: visible in shell history)");
	console.error("  list                List secret names");
	console.error("  rm <KEY>            Remove a secret");
	console.error("");
	console.error("Options:");
	console.error("  --project, -p       Project name (auto-detected from cwd)");
	console.error("");
	console.error("Piping from stdin (for CI/CD):");
	console.error("  echo $SECRET | jack secrets set KEY");
	console.error("");
}

/**
 * Resolve project and determine if it's managed or BYO
 */
async function resolveProjectContext(options: SecretsOptions): Promise<{
	projectName: string;
	link: LocalProjectLink | null;
	isManaged: boolean;
	projectId: string | null;
}> {
	let projectName: string;

	if (options.project) {
		projectName = options.project;
	} else {
		try {
			projectName = await getProjectNameFromDir(process.cwd());
		} catch {
			error("Could not determine project");
			info("Run from a project directory, or use --project <name>");
			process.exit(1);
		}
	}

	// Read deploy mode from .jack/project.json
	const link = await readProjectLink(process.cwd());
	const isManaged = link?.deploy_mode === "managed";
	const projectId = link?.project_id ?? null;

	return { projectName, link, isManaged, projectId };
}

/**
 * Read a secret value interactively without echoing
 * Uses @clack/prompts password for robust handling of typing, pasting, and TTY
 */
async function readSecretInteractive(keyName: string): Promise<string> {
	const value = await passwordPrompt({
		message: `Enter value for ${keyName}`,
		mask: "*",
	});

	if (isCancel(value)) {
		throw new Error("Cancelled");
	}

	return value;
}

/**
 * Read secret value from stdin (for piping in CI/CD)
 */
async function readSecretFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];

	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}

	return Buffer.concat(chunks).toString("utf-8").trim();
}

/**
 * Set a secret value
 */
async function setSecret(args: string[], options: SecretsOptions): Promise<void> {
	const arg = args[0];

	if (!arg) {
		error("Missing secret key");
		info("Usage: jack secrets set <KEY> or jack secrets set KEY=VALUE");
		process.exit(1);
	}

	let keyName: string;
	let value: string | undefined;

	// Check for KEY=VALUE format
	const equalsIndex = arg.indexOf("=");
	if (equalsIndex > 0) {
		keyName = arg.slice(0, equalsIndex);
		value = arg.slice(equalsIndex + 1);

		// Warn about shell history exposure
		warn("Value visible in shell history. Use interactive mode for sensitive secrets.");
	} else {
		keyName = arg;
	}

	// Validate key name
	if (!/^[A-Z_][A-Z0-9_]*$/i.test(keyName)) {
		error("Invalid secret name");
		info(
			"Must start with a letter or underscore, and contain only letters, numbers, and underscores",
		);
		process.exit(1);
	}

	// Get value if not provided inline
	if (value === undefined) {
		// Check if stdin is piped
		if (!process.stdin.isTTY) {
			value = await readSecretFromStdin();
			if (!value) {
				error("No value provided via stdin");
				process.exit(1);
			}
		} else {
			// Interactive prompt
			try {
				value = await readSecretInteractive(keyName);
				if (!value) {
					error("No value provided");
					process.exit(1);
				}
			} catch (err) {
				if (err instanceof Error && err.message === "Cancelled") {
					info("Cancelled");
					process.exit(0);
				}
				throw err;
			}
		}
	}

	const { projectName, isManaged, projectId } = await resolveProjectContext(options);

	output.start("Setting secret...");

	if (isManaged && projectId) {
		// Managed mode: use control plane API
		await setSecretManaged(projectId, keyName, value);
	} else {
		// BYO mode: use wrangler
		await setSecretByo(projectName, keyName, value);
	}

	output.stop();
	success(`Secret set: ${keyName}`);

	// Warn about VITE_ prefix (informative, not blocking)
	if (keyName.startsWith("VITE_")) {
		info("Note: VITE_* variables are embedded at build time, not runtime.");
		info("For frontend access, add to .env and redeploy.");
	}
}

/**
 * Set secret via control plane (managed mode)
 */
async function setSecretManaged(projectId: string, name: string, value: string): Promise<void> {
	const { authFetch } = await import("../lib/auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/secrets`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, value }),
	});

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};

		output.stop();
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to set secret: ${response.status}`,
		);
	}
}

/**
 * Set secret via wrangler (BYO mode)
 */
async function setSecretByo(projectName: string, name: string, value: string): Promise<void> {
	// Use wrangler secret put with stdin
	const result = await $`echo ${value} | wrangler secret put ${name}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		output.stop();
		const stderr = result.stderr.toString();
		throw new JackError(
			JackErrorCode.DEPLOY_FAILED,
			`Failed to set secret: ${stderr}`,
			"Make sure wrangler is configured and the project is deployed",
		);
	}
}

/**
 * List secrets
 */
async function listSecrets(options: SecretsOptions): Promise<void> {
	const { projectName, isManaged, projectId } = await resolveProjectContext(options);

	output.start("Loading secrets...");

	let secrets: Array<{ name: string }>;

	if (isManaged && projectId) {
		secrets = await listSecretsManaged(projectId);
	} else {
		secrets = await listSecretsByo(projectName);
	}

	output.stop();

	if (secrets.length === 0) {
		info("No secrets configured");
		return;
	}

	console.error("");
	for (const secret of secrets) {
		console.error(`  ${secret.name}`);
	}
	console.error("");
}

/**
 * List secrets via control plane (managed mode)
 */
async function listSecretsManaged(projectId: string): Promise<Array<{ name: string }>> {
	const { authFetch } = await import("../lib/auth/index.ts");

	const response = await authFetch(`${getControlApiUrl()}/v1/projects/${projectId}/secrets`);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};

		output.stop();
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to list secrets: ${response.status}`,
		);
	}

	const data = (await response.json()) as { secrets: Array<{ name: string }> };
	return data.secrets;
}

/**
 * List secrets via wrangler (BYO mode)
 */
async function listSecretsByo(_projectName: string): Promise<Array<{ name: string }>> {
	const result = await $`wrangler secret list --format json`.nothrow().quiet();

	if (result.exitCode !== 0) {
		// If no secrets or project not deployed, return empty list
		const stderr = result.stderr.toString();
		if (stderr.includes("not found") || stderr.includes("does not exist")) {
			return [];
		}

		output.stop();
		throw new JackError(
			JackErrorCode.DEPLOY_FAILED,
			`Failed to list secrets: ${stderr}`,
			"Make sure wrangler is configured and the project is deployed",
		);
	}

	try {
		const stdout = result.stdout.toString().trim();
		if (!stdout) {
			return [];
		}

		const secrets = JSON.parse(stdout) as Array<{ name: string; type: string }>;
		return secrets.map((s) => ({ name: s.name }));
	} catch {
		// If JSON parsing fails, try line-by-line parsing
		const lines = result.stdout.toString().trim().split("\n");
		return lines.filter((line) => line.trim()).map((line) => ({ name: line.trim() }));
	}
}

/**
 * Remove a secret
 */
async function removeSecret(args: string[], options: SecretsOptions): Promise<void> {
	const keyName = args[0];

	if (!keyName) {
		error("Missing secret key");
		info("Usage: jack secrets rm <KEY>");
		process.exit(1);
	}

	const { projectName, isManaged, projectId } = await resolveProjectContext(options);

	output.start("Removing secret...");

	if (isManaged && projectId) {
		await removeSecretManaged(projectId, keyName);
	} else {
		await removeSecretByo(projectName, keyName);
	}

	output.stop();
	success(`Secret removed: ${keyName}`);
}

/**
 * Remove secret via control plane (managed mode)
 */
async function removeSecretManaged(projectId: string, name: string): Promise<void> {
	const { authFetch } = await import("../lib/auth/index.ts");

	const response = await authFetch(
		`${getControlApiUrl()}/v1/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
		{ method: "DELETE" },
	);

	if (!response.ok) {
		const err = (await response.json().catch(() => ({ message: "Unknown error" }))) as {
			message?: string;
		};

		output.stop();
		throw new JackError(
			JackErrorCode.INTERNAL_ERROR,
			err.message || `Failed to remove secret: ${response.status}`,
		);
	}
}

/**
 * Remove secret via wrangler (BYO mode)
 */
async function removeSecretByo(_projectName: string, name: string): Promise<void> {
	// Use yes | to auto-confirm the deletion
	const result = await $`yes | wrangler secret delete ${name}`.nothrow().quiet();

	if (result.exitCode !== 0) {
		output.stop();
		const stderr = result.stderr.toString();
		throw new JackError(
			JackErrorCode.DEPLOY_FAILED,
			`Failed to remove secret: ${stderr}`,
			"Make sure wrangler is configured and the project is deployed",
		);
	}
}
