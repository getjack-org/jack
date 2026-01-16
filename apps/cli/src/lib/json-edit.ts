import { existsSync } from "node:fs";

export function setJsonPath(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const keys = path.split(".").filter(Boolean);
	let current: Record<string, unknown> = target;

	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i];
		const next = current[key];
		if (!next || typeof next !== "object" || Array.isArray(next)) {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}

	const lastKey = keys[keys.length - 1];
	if (lastKey) {
		current[lastKey] = value;
	}
}

export async function applyJsonWrite(
	targetPath: string,
	updates: Record<string, string | { from: "input" }>,
	substitute: (value: string) => string,
	inputValue?: unknown,
): Promise<boolean> {
	let jsonData: Record<string, unknown> = {};

	if (existsSync(targetPath)) {
		try {
			const content = await Bun.file(targetPath).text();
			if (content.trim()) {
				jsonData = JSON.parse(content) as Record<string, unknown>;
			}
		} catch {
			return false;
		}
	}

	for (const [path, value] of Object.entries(updates)) {
		if (typeof value === "string") {
			setJsonPath(jsonData, path, substitute(value));
		} else if (value?.from === "input") {
			setJsonPath(jsonData, path, inputValue);
		}
	}

	await Bun.write(targetPath, `${JSON.stringify(jsonData, null, 2)}\n`);
	return true;
}
