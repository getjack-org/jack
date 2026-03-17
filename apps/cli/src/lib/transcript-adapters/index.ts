import { stat } from "node:fs/promises";
import { claudeTranscriptAdapter, findClaudeTranscriptPath } from "./claude.ts";
import { codexTranscriptAdapter, findCodexTranscriptPath } from "./codex.ts";
import type { TranscriptAdapter, TranscriptSource } from "./types.ts";

const ADAPTERS: TranscriptAdapter[] = [claudeTranscriptAdapter, codexTranscriptAdapter];

export function getTranscriptAdapters(): TranscriptAdapter[] {
	return ADAPTERS;
}

export function getTranscriptAdapterById(adapterId: string): TranscriptAdapter | null {
	return ADAPTERS.find((adapter) => adapter.id === adapterId) ?? null;
}

async function getSourceMtimeMs(source: TranscriptSource): Promise<number> {
	try {
		return (await stat(source.path)).mtimeMs;
	} catch {
		return -1;
	}
}

export async function detectTranscriptSource(
	projectDir: string,
	hintPath?: string,
): Promise<TranscriptSource | null> {
	if (hintPath) {
		for (const adapter of ADAPTERS) {
			const source = await adapter.sourceFromHint?.(hintPath, projectDir);
			if (source) return source;
		}
	}

	const detected: TranscriptSource[] = [];
	for (const adapter of ADAPTERS) {
		const source = await adapter.detect(projectDir);
		if (source) detected.push(source);
	}
	if (detected.length === 0) {
		return null;
	}

	const explicitProvider = process.env.JACK_TRANSCRIPT_PROVIDER?.trim();
	if (explicitProvider) {
		const preferred = detected.find((source) => source.adapterId === explicitProvider);
		if (preferred) return preferred;
	}

	const firstDetected = detected[0];
	if (!firstDetected) {
		return null;
	}

	let best = firstDetected;
	let bestMtimeMs = await getSourceMtimeMs(best);
	for (let i = 1; i < detected.length; i++) {
		const candidate = detected[i];
		if (!candidate) continue;
		const candidateMtimeMs = await getSourceMtimeMs(candidate);
		if (candidateMtimeMs > bestMtimeMs) {
			best = candidate;
			bestMtimeMs = candidateMtimeMs;
		}
	}

	return best;
}

export function findAnyTranscriptPath(projectDir: string): string | null {
	return findClaudeTranscriptPath(projectDir) ?? findCodexTranscriptPath(projectDir);
}
