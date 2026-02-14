import * as esbuild from "esbuild-wasm";
// @ts-expect-error — wasm module import
import esbuildWasm from "esbuild-wasm/esbuild.wasm";

let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
	if (!initPromise) {
		initPromise = esbuild.initialize({ wasmModule: esbuildWasm, worker: false }).catch((err) => {
			initPromise = null;
			throw err;
		});
	}
	await initPromise;
}

function detectEntrypoint(files: Record<string, string>): string {
	if (files["package.json"]) {
		try {
			const pkg = JSON.parse(files["package.json"]);
			if (pkg.main && files[pkg.main]) return pkg.main;
		} catch {}
	}

	const candidates = [
		"src/index.ts",
		"src/index.tsx",
		"src/index.js",
		"index.ts",
		"index.js",
		"worker.ts",
		"worker.js",
	];

	for (const candidate of candidates) {
		if (files[candidate]) return candidate;
	}

	const firstSource = Object.keys(files).find(
		(f) => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".tsx"),
	);
	if (firstSource) return firstSource;

	throw new Error(
		"Could not detect entrypoint. Include src/index.ts, index.ts, or set 'main' in package.json.",
	);
}

function resolvePath(dir: string, relative: string): string {
	const parts = dir ? dir.split("/") : [];
	for (const segment of relative.split("/")) {
		if (segment === "..") {
			parts.pop();
		} else if (segment !== "." && segment !== "") {
			parts.push(segment);
		}
	}
	return parts.join("/");
}

function parseDependencies(files: Record<string, string>): Record<string, string> {
	if (!files["package.json"]) return {};
	try {
		const pkg = JSON.parse(files["package.json"]);
		return pkg.dependencies || {};
	} catch {
		return {};
	}
}

function virtualFsPlugin(files: Record<string, string>): esbuild.Plugin {
	return {
		name: "virtual-fs",
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === "entry-point") {
					return { path: args.path, namespace: "virtual" };
				}
				return undefined;
			});

			build.onResolve({ filter: /^\./ }, (args) => {
				if (args.namespace !== "virtual") return undefined;

				const dir = args.importer.includes("/")
					? args.importer.substring(0, args.importer.lastIndexOf("/"))
					: "";
				const resolved = resolvePath(dir, args.path);

				if (files[resolved]) {
					return { path: resolved, namespace: "virtual" };
				}

				for (const ext of [".ts", ".tsx", ".js", ".jsx", ".json"]) {
					if (files[resolved + ext]) {
						return { path: resolved + ext, namespace: "virtual" };
					}
				}

				for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
					const indexPath = `${resolved}/index${ext}`;
					if (files[indexPath]) {
						return { path: indexPath, namespace: "virtual" };
					}
				}

				return undefined;
			});

			build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
				const content = files[args.path];
				if (content === undefined) {
					return {
						errors: [{ text: `File not found in source: ${args.path}` }],
					};
				}

				const loader = args.path.endsWith(".ts")
					? "ts"
					: args.path.endsWith(".tsx")
						? "tsx"
						: args.path.endsWith(".jsx")
							? "jsx"
							: args.path.endsWith(".json")
								? "json"
								: "js";

				return { contents: content, loader };
			});
		},
	};
}

/** Resolves bare npm specifiers via esm.sh CDN with version pins from package.json. */
function esmShPlugin(deps: Record<string, string>): esbuild.Plugin {
	return {
		name: "esm-sh",
		setup(build) {
			build.onResolve({ filter: /^[^./]/ }, (args) => {
				if (args.namespace === "virtual" && args.kind === "entry-point") {
					return undefined;
				}

				if (args.path.startsWith("node:")) {
					return { path: args.path, external: true };
				}

				const parts = args.path.split("/");
				const pkgName = args.path.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
				const subpath = args.path.startsWith("@")
					? parts.slice(2).join("/")
					: parts.slice(1).join("/");

				const version = deps[pkgName] || "latest";
				const cleanVersion = version.replace(/^[\^~>=<\s]+/, "");

				let url = `https://esm.sh/${pkgName}@${cleanVersion}`;
				if (subpath) url += `/${subpath}`;
				url += "?target=es2022";

				return { path: url, namespace: "cdn" };
			});

			build.onLoad({ filter: /.*/, namespace: "cdn" }, async (args) => {
				const response = await fetch(args.path, {
					headers: { "User-Agent": "jack-mcp-bundler/1.0" },
				});
				if (!response.ok) {
					return {
						errors: [
							{
								text: `Failed to fetch ${args.path}: ${response.status} ${response.statusText}`,
							},
						],
					};
				}
				const contents = await response.text();
				return { contents, loader: "js" };
			});

			build.onResolve({ filter: /.*/, namespace: "cdn" }, (args) => {
				if (args.path.startsWith("https://")) {
					return { path: args.path, namespace: "cdn" };
				}
				if (args.path.startsWith("/")) {
					return {
						path: `https://esm.sh${args.path}`,
						namespace: "cdn",
					};
				}
				try {
					const url = new URL(args.path, args.importer);
					return { path: url.href, namespace: "cdn" };
				} catch {
					return {
						errors: [
							{
								text: `Cannot resolve ${args.path} from ${args.importer}`,
							},
						],
					};
				}
			});
		},
	};
}

export interface BundleResult {
	code: string;
	entrypoint: string;
	warnings: string[];
}

export async function bundleCode(files: Record<string, string>): Promise<BundleResult> {
	await ensureInitialized();

	const entrypoint = detectEntrypoint(files);
	const deps = parseDependencies(files);

	const result = await esbuild.build({
		entryPoints: [entrypoint],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2022",
		write: false,
		minify: false,
		plugins: [virtualFsPlugin(files), esmShPlugin(deps)],
	});

	if (result.outputFiles.length === 0) {
		throw new Error("esbuild produced no output");
	}

	const warnings = result.warnings.map(
		(w) => `${w.location?.file || ""}:${w.location?.line || ""} ${w.text}`,
	);

	return {
		code: result.outputFiles[0].text,
		entrypoint,
		warnings,
	};
}
