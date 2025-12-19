import { input, select } from "@inquirer/prompts";
import type { DetectedSecret } from "./env-parser.ts";
import { info, success, warn } from "./output.ts";
import { getSavedSecrets, getSecretsPath, maskSecret, saveSecrets } from "./secrets.ts";

/**
 * Prompt user to save detected secrets after deploy
 */
export async function promptSaveSecrets(detected: DetectedSecret[]): Promise<void> {
	if (detected.length === 0) {
		return;
	}

	// Check if running in TTY
	if (!process.stdout.isTTY) {
		return;
	}

	console.error("");
	info("Found secrets in your environment:");
	for (const secret of detected) {
		console.error(`  • ${secret.key} (from ${secret.source})`);
	}
	console.error("");

	const action = await select({
		message: "What would you like to do?",
		choices: [
			{ value: "save", name: "Save to jack for future projects" },
			{ value: "paste", name: "Paste additional secrets" },
			{ value: "skip", name: "Skip for now" },
		],
	});

	if (action === "skip") {
		return;
	}

	const secretsToSave: Array<{ key: string; value: string; source: string }> = detected.map(
		(s) => ({
			key: s.key,
			value: s.value,
			source: s.source,
		}),
	);

	if (action === "paste") {
		// Allow user to paste additional secrets
		const additional = await promptAdditionalSecrets();
		secretsToSave.push(...additional);
	}

	if (secretsToSave.length > 0) {
		await saveSecrets(secretsToSave);
		success(`Saved ${secretsToSave.length} secret(s) to ${getSecretsPath()}`);
	}
}

/**
 * Prompt user for additional secrets (manual entry)
 */
async function promptAdditionalSecrets(): Promise<
	Array<{ key: string; value: string; source: string }>
> {
	const secrets: Array<{ key: string; value: string; source: string }> = [];

	while (true) {
		const key = await input({
			message: "Enter secret name (or press enter to finish):",
		});

		if (!key.trim()) {
			break;
		}

		const value = await input({
			message: `Enter value for ${key}:`,
		});

		if (value.trim()) {
			secrets.push({ key: key.trim(), value: value.trim(), source: "manual" });
		}
	}

	return secrets;
}

/**
 * Prompt user to reuse saved secrets on init
 */
export async function promptUseSecrets(): Promise<Record<string, string> | null> {
	// Check if running in TTY
	if (!process.stdout.isTTY) {
		return null;
	}

	const saved = await getSavedSecrets();
	const secretCount = Object.keys(saved).length;

	if (secretCount === 0) {
		return null;
	}

	info(`Found ${secretCount} saved secret(s)`);
	for (const key of Object.keys(saved)) {
		console.error(`  • ${key}`);
	}
	console.error("");

	console.error("  Esc to skip\n");
	const action = await select({
		message: "Use them for this project?",
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	if (action === "yes") {
		return saved;
	}

	return null;
}

/**
 * Filter out secrets that are already saved globally
 */
export async function filterNewSecrets(detected: DetectedSecret[]): Promise<DetectedSecret[]> {
	const saved = await getSavedSecrets();

	return detected.filter((secret) => {
		const savedValue = saved[secret.key];
		// Include if not saved, or if value has changed
		return !savedValue || savedValue !== secret.value;
	});
}

/**
 * Prompt user to use specific secrets from a list
 */
export async function promptUseSecretsFromList(
	secrets: Array<{ key: string; value: string; source: string }>,
): Promise<boolean> {
	// Check if running in TTY
	if (!process.stdout.isTTY) {
		return false;
	}

	if (secrets.length === 0) {
		return false;
	}

	console.error("  Esc to skip\n");
	const action = await select({
		message: "Use saved secrets for this project?",
		choices: [
			{ name: "1. Yes", value: "yes" },
			{ name: "2. No", value: "no" },
		],
	});

	return action === "yes";
}
