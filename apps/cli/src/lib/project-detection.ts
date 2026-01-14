import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { DEFAULT_EXCLUDES } from "./storage/file-filter.ts";

export type ProjectType = "vite" | "sveltekit" | "hono" | "unknown";

export interface DetectionResult {
	type: ProjectType;
	configFile?: string;
	entryPoint?: string;
	error?: string;
	unsupportedFramework?:
		| "nextjs"
		| "astro"
		| "nuxt"
		| "remix"
		| "react-router"
		| "tanstack-start"
		| "tauri";
	detectedDeps?: string[];
	configFiles?: string[];
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
	fileCount?: number;
	totalSizeKb?: number;
}

interface PackageJson {
	name?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

const CONFIG_EXTENSIONS = [".ts", ".js", ".mjs"];
const HONO_ENTRY_CANDIDATES = [
	"src/index.ts",
	"src/index.js",
	"index.ts",
	"index.js",
	"src/server.ts",
	"src/server.js",
];

const MAX_FILES = 1000;
const MAX_SIZE_KB = 50 * 1024; // 50MB in KB

function hasDep(pkg: PackageJson, name: string): boolean {
	return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function hasConfigFile(projectPath: string, baseName: string): string | null {
	for (const ext of CONFIG_EXTENSIONS) {
		const configPath = join(projectPath, `${baseName}${ext}`);
		if (existsSync(configPath)) {
			return `${baseName}${ext}`;
		}
	}
	return null;
}

function readPackageJson(projectPath: string): PackageJson | null {
	const packageJsonPath = join(projectPath, "package.json");
	if (!existsSync(packageJsonPath)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return null;
	}
}

// Error messages with helpful setup instructions for each framework
const FRAMEWORK_SETUP_MESSAGES: Record<string, string> = {
	nextjs: `Next.js project detected!

Next.js support requires OpenNext. For now, set up manually:
1. bun add @opennextjs/cloudflare
2. Create open-next.config.ts
3. Create wrangler.jsonc manually

Docs: https://opennext.js.org/cloudflare`,

	astro: `Astro project detected!

Auto-deploy coming soon. For now, set up manually:
1. bun add @astrojs/cloudflare
2. Configure adapter in astro.config.mjs
3. Create wrangler.jsonc with main: "dist/_worker.js"

Docs: https://docs.astro.build/en/guides/deploy/cloudflare/
Want this supported? Run: jack feedback`,

	nuxt: `Nuxt project detected!

Auto-deploy coming soon. For now, set up manually:
1. Set nitro.preset to 'cloudflare' in nuxt.config.ts
2. Run: NITRO_PRESET=cloudflare bunx nuxt build
3. Create wrangler.jsonc with main: ".output/server/index.mjs"

Docs: https://nuxt.com/deploy/cloudflare
Want this supported? Run: jack feedback`,

	remix: `Remix project detected!

Remix has been superseded by React Router v7. Consider migrating:
https://reactrouter.com/upgrading/remix

Or set up Remix for Cloudflare manually:
1. Use @remix-run/cloudflare adapter
2. Create wrangler.jsonc manually`,

	"react-router": `React Router v7 project detected!

Auto-deploy coming soon. For now, set up manually:
1. bun add @react-router/cloudflare @cloudflare/vite-plugin
2. Configure cloudflare() plugin in vite.config.ts
3. Create wrangler.jsonc with main: "build/server/index.js"

Docs: https://reactrouter.com/deploying/cloudflare
Want this supported? Run: jack feedback`,

	"tanstack-start": `TanStack Start project detected!

Auto-deploy coming soon. For now, set up manually:
1. bun add -d @cloudflare/vite-plugin
2. Configure cloudflare() plugin in vite.config.ts
3. Set target: 'cloudflare-module' in tanstackStart() config
4. Create wrangler.jsonc with main: ".output/server/index.mjs"

Docs: https://tanstack.com/start/latest/docs/framework/react/hosting#cloudflare
Want this supported? Run: jack feedback`,

	tauri: `Tauri desktop app detected!

Tauri apps are native desktop applications and cannot be deployed to Cloudflare Workers.
jack is for web apps that run in the browser or on the edge.

If you have a web frontend in this project, consider deploying it separately.`,
};

type UnsupportedFramework =
	| "nextjs"
	| "astro"
	| "nuxt"
	| "remix"
	| "react-router"
	| "tanstack-start"
	| "tauri";

function detectUnsupportedFramework(
	projectPath: string,
	pkg: PackageJson | null,
): UnsupportedFramework | null {
	// Next.js - check config file
	if (hasConfigFile(projectPath, "next.config")) {
		return "nextjs";
	}

	// Astro - check config file AND dependency (to avoid false positives)
	if (hasConfigFile(projectPath, "astro.config") && pkg && hasDep(pkg, "astro")) {
		return "astro";
	}

	// React Router v7 - check for @react-router/dev (BEFORE checking Nuxt to avoid conflicts)
	if (pkg && hasDep(pkg, "@react-router/dev")) {
		return "react-router";
	}

	// TanStack Start - check for @tanstack/react-start or @tanstack/start
	if (pkg && (hasDep(pkg, "@tanstack/react-start") || hasDep(pkg, "@tanstack/start"))) {
		return "tanstack-start";
	}

	// Nuxt - check config file AND dependency
	if (hasConfigFile(projectPath, "nuxt.config") && pkg && hasDep(pkg, "nuxt")) {
		return "nuxt";
	}

	// Legacy Remix (not React Router v7)
	if (pkg && (hasDep(pkg, "@remix-run/node") || hasDep(pkg, "@remix-run/react"))) {
		return "remix";
	}

	// Tauri - desktop app framework (check for src-tauri dir or tauri deps)
	if (
		existsSync(join(projectPath, "src-tauri")) ||
		(pkg && (hasDep(pkg, "@tauri-apps/cli") || hasDep(pkg, "@tauri-apps/api")))
	) {
		return "tauri";
	}

	return null;
}

function findHonoEntry(projectPath: string): string | null {
	for (const candidate of HONO_ENTRY_CANDIDATES) {
		if (existsSync(join(projectPath, candidate))) {
			return candidate;
		}
	}
	return null;
}

export function detectProjectType(projectPath: string): DetectionResult {
	const pkg = readPackageJson(projectPath);
	const detectedDeps: string[] = [];
	const configFiles: string[] = [];

	// Check for unsupported/coming-soon frameworks first (before reading package.json)
	// This provides better error messages for frameworks we recognize but don't auto-deploy yet
	const unsupported = detectUnsupportedFramework(projectPath, pkg);
	if (unsupported) {
		// Collect detected config files for reporting
		const configFileMap: Record<string, string> = {
			nextjs: "next.config",
			astro: "astro.config",
			nuxt: "nuxt.config",
		};

		if (configFileMap[unsupported]) {
			const configFile = hasConfigFile(projectPath, configFileMap[unsupported]);
			if (configFile) {
				configFiles.push(configFile);
			}
		}

		// Collect detected dependencies
		if (pkg) {
			if (unsupported === "astro" && hasDep(pkg, "astro")) detectedDeps.push("astro");
			if (unsupported === "nuxt" && hasDep(pkg, "nuxt")) detectedDeps.push("nuxt");
			if (unsupported === "react-router" && hasDep(pkg, "@react-router/dev"))
				detectedDeps.push("@react-router/dev");
			if (
				unsupported === "tanstack-start" &&
				(hasDep(pkg, "@tanstack/react-start") || hasDep(pkg, "@tanstack/start"))
			) {
				detectedDeps.push(
					hasDep(pkg, "@tanstack/react-start") ? "@tanstack/react-start" : "@tanstack/start",
				);
			}
			if (unsupported === "remix") {
				if (hasDep(pkg, "@remix-run/node")) detectedDeps.push("@remix-run/node");
				if (hasDep(pkg, "@remix-run/react")) detectedDeps.push("@remix-run/react");
			}
		}

		return {
			type: "unknown",
			unsupportedFramework: unsupported,
			error: FRAMEWORK_SETUP_MESSAGES[unsupported],
			detectedDeps,
			configFiles,
		};
	}

	if (!pkg) {
		return {
			type: "unknown",
			error: "No package.json found",
		};
	}

	// SvelteKit detection
	const svelteConfig = hasConfigFile(projectPath, "svelte.config");
	if (svelteConfig && hasDep(pkg, "@sveltejs/kit")) {
		configFiles.push(svelteConfig);
		detectedDeps.push("@sveltejs/kit");

		if (!hasDep(pkg, "@sveltejs/adapter-cloudflare")) {
			return {
				type: "sveltekit",
				configFile: svelteConfig,
				error:
					"Missing @sveltejs/adapter-cloudflare dependency. Install it: bun add -D @sveltejs/adapter-cloudflare",
				detectedDeps,
				configFiles,
			};
		}

		detectedDeps.push("@sveltejs/adapter-cloudflare");
		return {
			type: "sveltekit",
			configFile: svelteConfig,
			detectedDeps,
			configFiles,
		};
	}

	// Vite detection
	const viteConfig = hasConfigFile(projectPath, "vite.config");
	if (viteConfig && hasDep(pkg, "vite")) {
		configFiles.push(viteConfig);
		detectedDeps.push("vite");
		return {
			type: "vite",
			configFile: viteConfig,
			detectedDeps,
			configFiles,
		};
	}

	// Hono detection
	if (hasDep(pkg, "hono")) {
		detectedDeps.push("hono");
		const entryPoint = findHonoEntry(projectPath);
		if (entryPoint) {
			return {
				type: "hono",
				entryPoint,
				detectedDeps,
				configFiles,
			};
		}
		return {
			type: "hono",
			error:
				"Hono detected but no entry file found. Expected: src/index.ts, index.ts, src/server.ts, or similar.",
			detectedDeps,
			configFiles,
		};
	}

	return {
		type: "unknown",
		error: "Could not detect project type. Supported: Vite, SvelteKit, Hono.",
		detectedDeps,
		configFiles,
	};
}

function shouldExclude(relativePath: string): boolean {
	for (const pattern of DEFAULT_EXCLUDES) {
		const glob = new Glob(pattern);
		if (glob.match(relativePath)) {
			return true;
		}
	}
	return false;
}

export async function validateProject(projectPath: string): Promise<ValidationResult> {
	if (!existsSync(join(projectPath, "package.json"))) {
		return {
			valid: false,
			error: "No package.json found in project directory",
		};
	}

	let fileCount = 0;
	let totalSizeBytes = 0;

	try {
		const entries = await readdir(projectPath, {
			recursive: true,
			withFileTypes: true,
		});

		for (const entry of entries) {
			if (!entry.isFile()) {
				continue;
			}

			const parentDir = entry.parentPath ?? projectPath;
			const absolutePath = join(parentDir, entry.name);
			const relativePath = relative(projectPath, absolutePath);

			if (shouldExclude(relativePath)) {
				continue;
			}

			fileCount++;
			if (fileCount > MAX_FILES) {
				return {
					valid: false,
					error: `Project has more than ${MAX_FILES} files (excluding node_modules, .git, etc.)`,
					fileCount,
				};
			}

			const stats = await stat(absolutePath);
			totalSizeBytes += stats.size;
		}

		const totalSizeKb = Math.round(totalSizeBytes / 1024);

		if (totalSizeKb > MAX_SIZE_KB) {
			return {
				valid: false,
				error: `Project size exceeds ${MAX_SIZE_KB / 1024}MB limit (${Math.round(totalSizeKb / 1024)}MB)`,
				fileCount,
				totalSizeKb,
			};
		}

		return {
			valid: true,
			fileCount,
			totalSizeKb,
		};
	} catch (err) {
		return {
			valid: false,
			error: `Failed to scan project: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
