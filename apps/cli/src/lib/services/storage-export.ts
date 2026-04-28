import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { authFetch } from "../auth/index.ts";
import {
	type StorageExportObject,
	fetchStorageExportPage,
	getControlApiUrl,
} from "../control-plane.ts";
import { readProjectLink } from "../project-link.ts";

export interface StorageExportResult {
	bucket: string;
	outputDir: string;
	objectsDownloaded: number;
	skippedDirMarkers: number;
	totalBytes: number;
}

export interface StorageExportProgress {
	onPage?: (pageIndex: number, objectsInPage: number, cumulative: number) => void;
	onObject?: (key: string, downloaded: number) => void;
	onSkip?: (key: string, reason: string) => void;
}

const CONCURRENCY = 8;
const PAGE_LIMIT = 500;

interface ExportState {
	writtenPaths: Set<string>;
	skippedDirMarkers: number;
}

export async function exportStorageBucket(
	projectDir: string,
	bucketName: string,
	options: { outputDir?: string; progress?: StorageExportProgress } = {},
): Promise<StorageExportResult> {
	const link = await readProjectLink(projectDir);
	if (link?.deploy_mode !== "managed") {
		throw new Error(
			"storage export is only supported for managed projects (jack cloud). Use 'wrangler r2 object' for BYO mode.",
		);
	}

	const outputDir = resolve(projectDir, options.outputDir || `${bucketName}-export`);
	await mkdir(outputDir, { recursive: true });

	const state: ExportState = { writtenPaths: new Set(), skippedDirMarkers: 0 };

	let cursor: string | undefined;
	let pageIndex = 0;
	let totalDownloaded = 0;
	let totalBytes = 0;

	do {
		const page = await fetchStorageExportPage(link.project_id, bucketName, cursor, PAGE_LIMIT);
		options.progress?.onPage?.(pageIndex, page.objects.length, totalDownloaded);

		for (let i = 0; i < page.objects.length; i += CONCURRENCY) {
			const batch = page.objects.slice(i, i + CONCURRENCY);
			await Promise.all(
				batch.map(async (obj) => {
					const result = await downloadOne(obj, outputDir, state, options.progress);
					if (result === null) return;
					totalBytes += result;
					totalDownloaded += 1;
					options.progress?.onObject?.(obj.key, totalDownloaded);
				}),
			);
		}

		cursor = page.next_cursor || undefined;
		pageIndex += 1;
	} while (cursor);

	return {
		bucket: bucketName,
		outputDir,
		objectsDownloaded: totalDownloaded,
		skippedDirMarkers: state.skippedDirMarkers,
		totalBytes,
	};
}

async function downloadOne(
	obj: StorageExportObject,
	outputDir: string,
	state: ExportState,
	progress: StorageExportProgress | undefined,
): Promise<number | null> {
	const safeKey = obj.key.replace(/^\/+/, "");

	if (!safeKey) {
		state.skippedDirMarkers += 1;
		progress?.onSkip?.(obj.key, "empty key");
		return null;
	}

	// S3 directory markers are zero-byte placeholders ending in "/". They have no payload
	// and can't be written as files (the path resolves to a directory). Skip them silently.
	if (safeKey.endsWith("/")) {
		state.skippedDirMarkers += 1;
		progress?.onSkip?.(obj.key, "directory marker");
		return null;
	}

	if (safeKey.includes("\\")) {
		throw new Error(`Refusing to download object with backslash in key: ${obj.key}`);
	}
	if (safeKey.split("/").some((seg) => seg === "..")) {
		throw new Error(`Refusing to download object with '..' segment: ${obj.key}`);
	}

	const target = resolve(outputDir, safeKey);
	const rel = relative(outputDir, target);
	if (rel === "" || rel.startsWith("..") || resolve(outputDir, rel) !== target) {
		throw new Error(`Refusing to download object outside export dir: ${obj.key}`);
	}

	if (state.writtenPaths.has(target)) {
		throw new Error(
			`Path collision: key '${obj.key}' would overwrite a previously downloaded object at ${target}`,
		);
	}
	state.writtenPaths.add(target);

	await mkdir(dirname(target), { recursive: true });

	const res = await authFetch(`${getControlApiUrl()}${obj.download_path}`);
	if (!res.ok) {
		throw new Error(`Download failed for ${obj.key}: ${res.status}`);
	}

	const body = await res.arrayBuffer();
	await Bun.write(target, body);
	return obj.size;
}
