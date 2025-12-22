import { existsSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SecretEntry {
	value: string;
	createdAt: string;
	source?: string;
}

export interface SecretsFile {
	version: number;
	secrets: Record<string, SecretEntry>;
}

const CONFIG_DIR = join(homedir(), ".config", "jack");
const SECRETS_PATH = join(CONFIG_DIR, "secrets.json");

/**
 * Ensure config directory exists
 */
async function ensureConfigDir(): Promise<void> {
	if (!existsSync(CONFIG_DIR)) {
		await mkdir(CONFIG_DIR, { recursive: true });
	}
}

/**
 * Read secrets file, return empty if doesn't exist
 */
export async function readSecrets(): Promise<SecretsFile> {
	if (!existsSync(SECRETS_PATH)) {
		return { version: 1, secrets: {} };
	}

	try {
		const content = await Bun.file(SECRETS_PATH).json();
		return content as SecretsFile;
	} catch {
		// Corrupted file, return empty
		return { version: 1, secrets: {} };
	}
}

/**
 * Write secrets file with secure permissions (chmod 600)
 */
export async function writeSecrets(data: SecretsFile): Promise<void> {
	await ensureConfigDir();
	await Bun.write(SECRETS_PATH, JSON.stringify(data, null, 2));
	await chmod(SECRETS_PATH, 0o600);
}

/**
 * Check if secrets file has correct permissions
 */
export async function checkPermissions(): Promise<{ valid: boolean; message?: string }> {
	if (!existsSync(SECRETS_PATH)) {
		return { valid: true };
	}

	const stats = await stat(SECRETS_PATH);
	const mode = stats.mode & 0o777;

	if (mode & 0o077) {
		return {
			valid: false,
			message: `Insecure permissions on ${SECRETS_PATH}. Run: chmod 600 ${SECRETS_PATH}`,
		};
	}

	return { valid: true };
}

/**
 * Save secrets to global store
 */
export async function saveSecrets(
	secrets: Array<{ key: string; value: string; source?: string }>,
): Promise<void> {
	const data = await readSecrets();

	for (const { key, value, source } of secrets) {
		data.secrets[key] = {
			value,
			createdAt: new Date().toISOString(),
			source,
		};
	}

	await writeSecrets(data);
}

/**
 * Get all saved secrets as key-value pairs
 */
export async function getSavedSecrets(): Promise<Record<string, string>> {
	const data = await readSecrets();
	const result: Record<string, string> = {};

	for (const [key, entry] of Object.entries(data.secrets)) {
		result[key] = entry.value;
	}

	return result;
}

/**
 * Check if any secrets exist
 */
export async function hasSecrets(): Promise<boolean> {
	const data = await readSecrets();
	return Object.keys(data.secrets).length > 0;
}

/**
 * Mask a secret value for display
 */
export function maskSecret(value: string): string {
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Get secrets file path (for display purposes)
 */
export function getSecretsPath(): string {
	return SECRETS_PATH;
}
