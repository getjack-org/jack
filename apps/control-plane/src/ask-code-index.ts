import { unzipSync } from "fflate";
import type { Bindings, Deployment } from "./types";

export type AskCodeSymbolKind =
	| "route"
	| "function"
	| "class"
	| "export"
	| "env_binding"
	| "sql_ref";

export interface AskCodeSymbol {
	symbol: string;
	kind: AskCodeSymbolKind;
	lineStart: number | null;
	lineEnd: number | null;
	signature: string | null;
}

export interface AskCodeChunk {
	chunkIndex: number;
	lineStart: number | null;
	lineEnd: number | null;
	content: string;
}

export interface AskCodeParseResult {
	symbols: AskCodeSymbol[];
	chunks: AskCodeChunk[];
}

export interface CodeIndexAdapter {
	readonly id: string;
	readonly version: string;
	supports(path: string): boolean;
	parse(file: { path: string; content: string }): AskCodeParseResult;
}

export interface AskCodeIndexStatus {
	projectId: string;
	deploymentId: string;
	indexedAt: string;
	parserVersion: string;
	status: "ready" | "indexing" | "failed";
	fileCount: number;
	symbolCount: number;
	chunkCount: number;
	lastDurationMs: number;
	queueAttempts: number;
	errorMessage: string | null;
}

export interface AskCodeSearchResult {
	path: string;
	chunkIndex: number | null;
	lineStart: number | null;
	lineEnd: number | null;
	snippet: string;
}

export interface AskRouteMatch {
	path: string;
	symbol: string;
	signature: string | null;
	lineStart: number | null;
	lineEnd: number | null;
}

const MAX_TEXT_FILE_BYTES = 300_000;
const CHUNK_LINES = 70;
const JS_TS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function hasSupportedTextExtension(path: string): boolean {
	const lower = path.toLowerCase();
	return (
		JS_TS_EXTENSIONS.some((ext) => lower.endsWith(ext)) ||
		lower.endsWith(".json") ||
		lower.endsWith(".md")
	);
}

function detectLanguage(path: string): string {
	const lower = path.toLowerCase();
	if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
	if (
		lower.endsWith(".js") ||
		lower.endsWith(".jsx") ||
		lower.endsWith(".mjs") ||
		lower.endsWith(".cjs")
	)
		return "javascript";
	if (lower.endsWith(".json")) return "json";
	if (lower.endsWith(".md")) return "markdown";
	return "text";
}

function tokenizeQuery(input: string): string[] {
	const terms = input
		.toLowerCase()
		.replace(/[^a-z0-9/_-]+/g, " ")
		.split(/\s+/)
		.flatMap((t) => t.split("/"))
		.filter((t) => t.length >= 2 && !/^\d+$/.test(t));
	return Array.from(new Set(terms)).slice(0, 10);
}

function toFtsQuery(input: string): string | null {
	const tokens = tokenizeQuery(input);
	if (tokens.length === 0) return null;
	return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" OR ");
}

function buildChunks(content: string): AskCodeChunk[] {
	const lines = content.split("\n");
	const chunks: AskCodeChunk[] = [];

	let chunkIndex = 0;
	for (let i = 0; i < lines.length; i += CHUNK_LINES) {
		const slice = lines.slice(i, i + CHUNK_LINES);
		const text = slice.join("\n").trim();
		if (!text) continue;
		chunks.push({
			chunkIndex,
			lineStart: i + 1,
			lineEnd: i + slice.length,
			content: text,
		});
		chunkIndex += 1;
	}
	return chunks;
}

const jsTsAdapter: CodeIndexAdapter = {
	id: "js_ts",
	version: "v1",
	supports(path: string): boolean {
		return JS_TS_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
	},
	parse(file: { path: string; content: string }): AskCodeParseResult {
		const lines = file.content.split("\n");
		const symbols: AskCodeSymbol[] = [];

		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			const lineNo = i + 1;

			// Route patterns: app.get("/x"), router.post("/x"), etc.
			const routeMatch = line.match(
				/\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/i,
			);
			if (routeMatch) {
				const method = routeMatch[1]?.toUpperCase() ?? "GET";
				const routePath = routeMatch[2] ?? "";
				symbols.push({
					symbol: `${method} ${routePath}`,
					kind: "route",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: `${method} ${routePath}`,
				});
			}

			// Basic pathname checks: pathname === "/x"
			const pathnameMatch = line.match(/\bpathname\s*={2,3}\s*["'`]([^"'`]+)["'`]/i);
			if (pathnameMatch) {
				const routePath = pathnameMatch[1] ?? "";
				symbols.push({
					symbol: `ROUTE ${routePath}`,
					kind: "route",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: `ROUTE ${routePath}`,
				});
			}

			// Function declarations
			const fnMatch = line.match(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/);
			if (fnMatch) {
				symbols.push({
					symbol: fnMatch[1] ?? "function",
					kind: "function",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: line.trim().slice(0, 240),
				});
			}

			// Class declarations
			const classMatch = line.match(/\bclass\s+([A-Za-z0-9_]+)/);
			if (classMatch) {
				symbols.push({
					symbol: classMatch[1] ?? "class",
					kind: "class",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: line.trim().slice(0, 240),
				});
			}

			// Export declarations
			if (/\bexport\b/.test(line)) {
				symbols.push({
					symbol: line.trim().slice(0, 120),
					kind: "export",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: line.trim().slice(0, 240),
				});
			}

			// env bindings
			const envRegex = /\benv\.([A-Z_][A-Z0-9_]*)\b/g;
			for (const match of line.matchAll(envRegex)) {
				const binding = match[1];
				if (!binding) continue;
				symbols.push({
					symbol: binding,
					kind: "env_binding",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: `env.${binding}`,
				});
			}

			// SQL refs
			if (/\b(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i.test(line)) {
				symbols.push({
					symbol: line.trim().slice(0, 120),
					kind: "sql_ref",
					lineStart: lineNo,
					lineEnd: lineNo,
					signature: line.trim().slice(0, 240),
				});
			}
		}

		return {
			symbols,
			chunks: buildChunks(file.content),
		};
	},
};

const adapters: CodeIndexAdapter[] = [jsTsAdapter];

function selectAdapter(path: string): CodeIndexAdapter | null {
	for (const adapter of adapters) {
		if (adapter.supports(path)) return adapter;
	}
	return null;
}

function decodeText(bytes: Uint8Array): string | null {
	if (bytes.byteLength === 0) return "";
	if (bytes.byteLength > MAX_TEXT_FILE_BYTES) return null;
	return new TextDecoder().decode(bytes);
}

function toIsoTimestamp(value: string | null | undefined): string {
	if (!value) return new Date().toISOString();
	if (value.includes("T")) return value;
	return `${value.replace(" ", "T")}Z`;
}

function parseNullableInt(value: unknown): number | null {
	if (value === null || value === undefined || value === "") return null;
	const num = typeof value === "number" ? value : Number(value);
	return Number.isFinite(num) ? num : null;
}

function safeErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 500);
	return String(error).slice(0, 500);
}

async function markIndexStatus(
	env: Bindings,
	input: {
		projectId: string;
		deploymentId: string;
		parserVersion: string;
		status: "ready" | "indexing" | "failed";
		fileCount?: number;
		symbolCount?: number;
		chunkCount?: number;
		lastDurationMs?: number;
		queueAttempts?: number;
		errorMessage?: string | null;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ask_code_index_latest
       (project_id, deployment_id, indexed_at, parser_version, status, file_count, symbol_count, chunk_count, last_duration_ms, queue_attempts, error_message)
       VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         deployment_id = excluded.deployment_id,
         indexed_at = CURRENT_TIMESTAMP,
         parser_version = excluded.parser_version,
         status = excluded.status,
         file_count = excluded.file_count,
         symbol_count = excluded.symbol_count,
         chunk_count = excluded.chunk_count,
         last_duration_ms = excluded.last_duration_ms,
         queue_attempts = excluded.queue_attempts,
         error_message = excluded.error_message`,
	)
		.bind(
			input.projectId,
			input.deploymentId,
			input.parserVersion,
			input.status,
			input.fileCount ?? 0,
			input.symbolCount ?? 0,
			input.chunkCount ?? 0,
			input.lastDurationMs ?? 0,
			input.queueAttempts ?? 1,
			input.errorMessage ?? null,
		)
		.run();
}

async function insertIndexRun(
	env: Bindings,
	input: {
		projectId: string;
		deploymentId: string;
		parserVersion: string;
		status: "ready" | "failed";
		queueAttempts: number;
		durationMs: number;
		fileCount: number;
		symbolCount: number;
		chunkCount: number;
		errorMessage: string | null;
	},
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO ask_code_index_runs
       (id, project_id, deployment_id, parser_version, status, queue_attempts, duration_ms, file_count, symbol_count, chunk_count, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			`idxrun_${crypto.randomUUID()}`,
			input.projectId,
			input.deploymentId,
			input.parserVersion,
			input.status,
			input.queueAttempts,
			input.durationMs,
			input.fileCount,
			input.symbolCount,
			input.chunkCount,
			input.errorMessage,
		)
		.run();
}

export async function markCodeIndexEnqueued(
	env: Bindings,
	input: {
		projectId: string;
		deploymentId: string;
		queueAttempts?: number;
	},
): Promise<void> {
	await markIndexStatus(env, {
		projectId: input.projectId,
		deploymentId: input.deploymentId,
		parserVersion: `${jsTsAdapter.id}:${jsTsAdapter.version}`,
		status: "indexing",
		fileCount: 0,
		symbolCount: 0,
		chunkCount: 0,
		lastDurationMs: 0,
		queueAttempts: input.queueAttempts ?? 1,
		errorMessage: null,
	});
}

export interface IndexLatestDeploymentOptions {
	queueAttempts?: number;
	rethrowOnFailure?: boolean;
}

export async function indexLatestDeploymentSource(
	env: Bindings,
	params: { projectId: string; deployment: Deployment } & IndexLatestDeploymentOptions,
): Promise<void> {
	const { projectId, deployment } = params;
	const parserVersion = `${jsTsAdapter.id}:${jsTsAdapter.version}`;
	const queueAttempts = params.queueAttempts ?? 1;
	const startedAt = Date.now();

	await markIndexStatus(env, {
		projectId,
		deploymentId: deployment.id,
		parserVersion,
		status: "indexing",
		queueAttempts,
	});

	try {
		if (!deployment.artifact_bucket_key) {
			throw new Error("Deployment has no artifact bucket key");
		}

		const sourceKey = `${deployment.artifact_bucket_key}/source.zip`;
		const sourceObj = await env.CODE_BUCKET.get(sourceKey);
		if (!sourceObj) {
			throw new Error("source.zip not found for deployment");
		}

		const zipData = await sourceObj.arrayBuffer();
		const files = unzipSync(new Uint8Array(zipData));

		const fileRows: Array<{
			path: string;
			language: string;
			contentHash: string;
			sizeBytes: number;
		}> = [];
		const symbolRows: Array<{
			path: string;
			symbol: string;
			kind: AskCodeSymbolKind;
			lineStart: number | null;
			lineEnd: number | null;
			signature: string | null;
		}> = [];
		const chunkRows: Array<{
			id: string;
			path: string;
			chunkIndex: number;
			lineStart: number | null;
			lineEnd: number | null;
			content: string;
		}> = [];

		for (const [rawPath, bytes] of Object.entries(files)) {
			const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
			if (!hasSupportedTextExtension(path)) continue;

			const text = decodeText(bytes);
			if (text === null) continue;

			const adapter = selectAdapter(path);
			const parsed = adapter
				? adapter.parse({ path, content: text })
				: ({
						symbols: [],
						chunks: buildChunks(text),
					} satisfies AskCodeParseResult);

			fileRows.push({
				path,
				language: detectLanguage(path),
				contentHash: `bytes:${bytes.byteLength}:sum:${bytes.reduce((acc, cur) => acc + cur, 0)}`,
				sizeBytes: bytes.byteLength,
			});

			const seenSymbolKeys = new Set<string>();
			for (const symbol of parsed.symbols) {
				const key = [
					symbol.kind,
					symbol.symbol,
					symbol.lineStart ?? "",
					symbol.lineEnd ?? "",
					symbol.signature ?? "",
				].join("|");
				if (seenSymbolKeys.has(key)) continue;
				seenSymbolKeys.add(key);

				symbolRows.push({
					path,
					symbol: symbol.symbol.slice(0, 200),
					kind: symbol.kind,
					lineStart: symbol.lineStart,
					lineEnd: symbol.lineEnd,
					signature: symbol.signature?.slice(0, 300) ?? null,
				});
			}

			for (const chunk of parsed.chunks) {
				chunkRows.push({
					id: crypto.randomUUID(),
					path,
					chunkIndex: chunk.chunkIndex,
					lineStart: chunk.lineStart,
					lineEnd: chunk.lineEnd,
					content: chunk.content.slice(0, 5000),
				});
			}
		}

		// Replace project snapshot
		await env.DB.prepare("DELETE FROM ask_code_files_latest WHERE project_id = ?")
			.bind(projectId)
			.run();
		await env.DB.prepare("DELETE FROM ask_code_symbols_latest WHERE project_id = ?")
			.bind(projectId)
			.run();
		await env.DB.prepare("DELETE FROM ask_code_chunks_latest WHERE project_id = ?")
			.bind(projectId)
			.run();
		await env.DB.prepare("DELETE FROM ask_code_chunks_latest_fts WHERE project_id = ?")
			.bind(projectId)
			.run();

		for (const row of fileRows) {
			await env.DB.prepare(
				`INSERT INTO ask_code_files_latest (project_id, path, language, content_hash, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
			)
				.bind(projectId, row.path, row.language, row.contentHash, row.sizeBytes)
				.run();
		}

		for (const row of symbolRows) {
			await env.DB.prepare(
				`INSERT OR IGNORE INTO ask_code_symbols_latest (project_id, path, symbol, kind, line_start, line_end, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(projectId, row.path, row.symbol, row.kind, row.lineStart, row.lineEnd, row.signature)
				.run();
		}

		for (const row of chunkRows) {
			await env.DB.prepare(
				`INSERT INTO ask_code_chunks_latest (id, project_id, path, chunk_index, line_start, line_end, content)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
				.bind(
					`${projectId}:${row.id}`,
					projectId,
					row.path,
					row.chunkIndex,
					row.lineStart,
					row.lineEnd,
					row.content,
				)
				.run();

			await env.DB.prepare(
				`INSERT INTO ask_code_chunks_latest_fts (project_id, path, chunk_index, line_start, line_end, content)
         VALUES (?, ?, ?, ?, ?, ?)`,
			)
				.bind(projectId, row.path, String(row.chunkIndex), row.lineStart, row.lineEnd, row.content)
				.run();
		}

		const durationMs = Date.now() - startedAt;
		await markIndexStatus(env, {
			projectId,
			deploymentId: deployment.id,
			parserVersion,
			status: "ready",
			fileCount: fileRows.length,
			symbolCount: symbolRows.length,
			chunkCount: chunkRows.length,
			lastDurationMs: durationMs,
			queueAttempts,
			errorMessage: null,
		});
		await insertIndexRun(env, {
			projectId,
			deploymentId: deployment.id,
			parserVersion,
			status: "ready",
			queueAttempts,
			durationMs,
			fileCount: fileRows.length,
			symbolCount: symbolRows.length,
			chunkCount: chunkRows.length,
			errorMessage: null,
		});
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const safeMessage = safeErrorMessage(error);
		await markIndexStatus(env, {
			projectId,
			deploymentId: deployment.id,
			parserVersion,
			status: "failed",
			lastDurationMs: durationMs,
			queueAttempts,
			errorMessage: safeMessage,
		});
		await insertIndexRun(env, {
			projectId,
			deploymentId: deployment.id,
			parserVersion,
			status: "failed",
			queueAttempts,
			durationMs,
			fileCount: 0,
			symbolCount: 0,
			chunkCount: 0,
			errorMessage: safeMessage,
		});
		if (params.rethrowOnFailure) {
			throw error;
		}
	}
}

export async function getLatestCodeIndexStatus(
	env: Bindings,
	projectId: string,
): Promise<AskCodeIndexStatus | null> {
	const row = await env.DB.prepare(
		`SELECT project_id, deployment_id, indexed_at, parser_version, status, file_count, symbol_count, chunk_count, last_duration_ms, queue_attempts, error_message
     FROM ask_code_index_latest
     WHERE project_id = ?`,
	)
		.bind(projectId)
		.first<{
			project_id: string;
			deployment_id: string;
			indexed_at: string;
			parser_version: string;
			status: "ready" | "indexing" | "failed";
			file_count: number;
			symbol_count: number;
			chunk_count: number;
			last_duration_ms: number;
			queue_attempts: number;
			error_message: string | null;
		}>();

	if (!row) return null;
	return {
		projectId: row.project_id,
		deploymentId: row.deployment_id,
		indexedAt: toIsoTimestamp(row.indexed_at),
		parserVersion: row.parser_version,
		status: row.status,
		fileCount: row.file_count,
		symbolCount: row.symbol_count,
		chunkCount: row.chunk_count,
		lastDurationMs: row.last_duration_ms,
		queueAttempts: row.queue_attempts,
		errorMessage: row.error_message,
	};
}

export async function searchLatestCodeIndex(
	env: Bindings,
	projectId: string,
	query: string,
	limit = 6,
): Promise<AskCodeSearchResult[]> {
	const ftsQuery = toFtsQuery(query);
	if (!ftsQuery) return [];

	const result = await env.DB.prepare(
		`SELECT path, chunk_index, line_start, line_end, substr(content, 1, 280) as snippet
     FROM ask_code_chunks_latest_fts
     WHERE ask_code_chunks_latest_fts MATCH ? AND project_id = ?
     LIMIT ?`,
	)
		.bind(ftsQuery, projectId, limit)
		.all<{
			path: string;
			chunk_index: string | number | null;
			line_start: string | number | null;
			line_end: string | number | null;
			snippet: string;
		}>();

	return (result.results ?? []).map((row) => ({
		path: row.path,
		chunkIndex: parseNullableInt(row.chunk_index),
		lineStart: parseNullableInt(row.line_start),
		lineEnd: parseNullableInt(row.line_end),
		snippet: row.snippet,
	}));
}

export async function findRouteMatchesForEndpoint(
	env: Bindings,
	projectId: string,
	endpointPath: string,
	limit = 5,
): Promise<AskRouteMatch[]> {
	const pattern = `%${endpointPath.toLowerCase()}%`;
	const result = await env.DB.prepare(
		`SELECT path, symbol, signature, line_start, line_end
     FROM ask_code_symbols_latest
     WHERE project_id = ? AND kind = 'route' AND lower(coalesce(signature, '')) LIKE ?
     ORDER BY path ASC, line_start ASC
     LIMIT ?`,
	)
		.bind(projectId, pattern, limit)
		.all<{
			path: string;
			symbol: string;
			signature: string | null;
			line_start: number | null;
			line_end: number | null;
		}>();

	return (result.results ?? []).map((row) => ({
		path: row.path,
		symbol: row.symbol,
		signature: row.signature,
		lineStart: row.line_start ?? null,
		lineEnd: row.line_end ?? null,
	}));
}

export async function searchSourceFallback(
	env: Bindings,
	deployment: Deployment,
	query: string,
	limit = 4,
): Promise<AskCodeSearchResult[]> {
	if (!deployment.artifact_bucket_key) return [];
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) return [];

	const sourceObj = await env.CODE_BUCKET.get(`${deployment.artifact_bucket_key}/source.zip`);
	if (!sourceObj) return [];

	const zipData = await sourceObj.arrayBuffer();
	const files = unzipSync(new Uint8Array(zipData));

	const results: AskCodeSearchResult[] = [];
	for (const [path, bytes] of Object.entries(files)) {
		if (!hasSupportedTextExtension(path)) continue;
		const text = decodeText(bytes);
		if (!text) continue;

		const lower = text.toLowerCase();
		const matched = tokens.some((token) => lower.includes(token));
		if (!matched) continue;

		results.push({
			path,
			chunkIndex: null,
			lineStart: null,
			lineEnd: null,
			snippet: text.slice(0, 280),
		});

		if (results.length >= limit) break;
	}

	return results;
}
