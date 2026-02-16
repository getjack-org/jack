/**
 * Validates that declared DO classes are actually exported from the built JS.
 */

import { join } from "node:path";

/**
 * Check built JS exports against declared DO class names.
 *
 * Uses Bun's transpiler to scan exports without executing the code.
 *
 * @returns class names NOT found in exports (empty = all good)
 */
export async function validateDoExports(
	outDir: string,
	entrypoint: string,
	classNames: string[],
): Promise<string[]> {
	const filePath = join(outDir, entrypoint);
	const code = await Bun.file(filePath).text();

	const transpiler = new Bun.Transpiler({ loader: "js" });
	const { exports } = transpiler.scan(code);

	return classNames.filter((name) => !exports.includes(name));
}
