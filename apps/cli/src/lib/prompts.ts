import { text } from "@clack/prompts";
import type { DetectedSecret } from "./env-parser.ts";
import { isCancel } from "./hooks.ts";
import { promptSelectValue } from "./hooks.ts";
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

	const action = await promptSelectValue("What would you like to do?", [
		{ value: "save", label: "Save to jack for future projects" },
		{ value: "paste", label: "Paste additional secrets" },
		{ value: "skip", label: "Skip for now" },
	]);

	if (isCancel(action) || action === "skip") {
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
		const key = await text({
			message: "Enter secret name (or press enter to finish):",
		});

		if (isCancel(key) || !key || !key.trim()) {
			break;
		}

		const value = await text({
			message: `Enter value for ${key}:`,
		});

		if (isCancel(value) || !value) {
			break;
		}

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

	const action = await promptSelectValue("Use them for this project?", [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	]);

	if (isCancel(action) || action !== "yes") {
		return null;
	}

	return saved;
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

	const action = await promptSelectValue("Use saved secrets for this project?", [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	]);

	return !isCancel(action) && action === "yes";
}
