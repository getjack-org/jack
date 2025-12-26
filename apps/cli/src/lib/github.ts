import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import type { AgentContext, Capability, Template, TemplateHooks } from "../templates/types";
import { parseJsonc } from "./jsonc.ts";
import type { ServiceTypeKey } from "./services/index.ts";

/**
 * Parse GitHub input: "user/repo" or "https://github.com/user/repo"
 */
function parseGitHubInput(input: string): { owner: string; repo: string } {
	// Full URL: https://github.com/user/repo
	const urlMatch = input.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
	if (urlMatch?.[1] && urlMatch[2]) {
		return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
	}

	// Shorthand: user/repo
	const shortMatch = input.match(/^([^\/]+)\/([^\/]+)$/);
	if (shortMatch?.[1] && shortMatch[2]) {
		return { owner: shortMatch[1], repo: shortMatch[2] };
	}

	throw new Error(
		`Invalid GitHub URL: ${input}\n\nExpected: user/repo or https://github.com/user/repo`,
	);
}

/**
 * Recursively read all files in a directory
 */
async function readDirRecursive(dir: string, base = ""): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = base ? `${base}/${entry.name}` : entry.name;
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			// Skip common non-source directories
			if (["node_modules", ".git", ".wrangler"].includes(entry.name)) continue;
			Object.assign(files, await readDirRecursive(fullPath, relativePath));
		} else {
			// Read file content
			const content = await readFile(fullPath, "utf-8");
			files[relativePath] = content;
		}
	}

	return files;
}

/**
 * Fetch template from GitHub tarball API
 */
export async function fetchFromGitHub(input: string): Promise<Template> {
	const { owner, repo } = parseGitHubInput(input);
	const tarballUrl = `https://api.github.com/repos/${owner}/${repo}/tarball`;

	// Fetch tarball
	const headers: Record<string, string> = {
		"User-Agent": "jack-cli",
	};
	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
	}

	const response = await fetch(tarballUrl, { headers, redirect: "follow" });

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				`Repository not found: ${owner}/${repo}\n\nMake sure it exists and is public.`,
			);
		}
		if (response.status === 403) {
			throw new Error(
				"GitHub rate limit exceeded.\n\nSet GITHUB_TOKEN to continue:\n  export GITHUB_TOKEN=ghp_xxxxx\n\nGet a token at: https://github.com/settings/tokens",
			);
		}
		throw new Error(`Failed to fetch template: ${response.statusText}`);
	}

	// Create temp directory
	const tempDir = await mkdtemp(join(tmpdir(), "jack-template-"));
	const tarPath = join(tempDir, "template.tar.gz");

	try {
		// Write tarball to temp file
		const buffer = await response.arrayBuffer();
		await Bun.write(tarPath, buffer);

		// Extract tarball
		await $`tar -xzf ${tarPath} -C ${tempDir}`.quiet();

		// Find extracted directory (GitHub tarballs have a prefix like "user-repo-sha")
		const entries = await readdir(tempDir);
		const extractedDir = entries.find((e) => e !== "template.tar.gz");
		if (!extractedDir) {
			throw new Error("Failed to extract template: no directory found");
		}

		// Read all files
		const files = await readDirRecursive(join(tempDir, extractedDir));

		// Warn if it doesn't look like a worker
		const hasWorkerFiles = files["wrangler.toml"] || files["worker.ts"] || files["src/index.ts"];
		if (!hasWorkerFiles) {
			console.warn("\n⚠ This doesn't look like a Cloudflare Worker");
			console.warn("  (no wrangler.toml or worker entry point found)\n");
		}

		// Read .jack.json metadata if it exists
		const jackJsonContent = files[".jack.json"];
		if (jackJsonContent) {
			try {
				const metadata = parseJsonc(jackJsonContent) as {
					description?: string;
					secrets?: string[];
					capabilities?: Capability[];
					requires?: ServiceTypeKey[];
					hooks?: TemplateHooks;
					agentContext?: AgentContext;
				};
				// Remove .jack.json from files (not needed in project)
				const { ".jack.json": _, ...filesWithoutJackJson } = files;
				return {
					description: metadata.description || `GitHub: ${owner}/${repo}`,
					secrets: metadata.secrets,
					capabilities: metadata.capabilities,
					requires: metadata.requires,
					hooks: metadata.hooks,
					agentContext: metadata.agentContext,
					files: filesWithoutJackJson,
				};
			} catch {
				// Invalid JSON, fall through to default
			}
		}

		return {
			description: `GitHub: ${owner}/${repo}`,
			files,
		};
	} finally {
		// Cleanup
		await rm(tempDir, { recursive: true, force: true });
	}
}
