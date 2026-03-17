export const CANONICAL_TURN_SCHEMA = "jack.turn.v1" as const;
export const CANONICAL_EVENT_SCHEMA = "jack.event.v1" as const;

export type CanonicalSchema = typeof CANONICAL_TURN_SCHEMA | typeof CANONICAL_EVENT_SCHEMA;

export type CanonicalEventType =
	| "user"
	| "assistant"
	| "message"
	| "tool_call"
	| "tool_result"
	| "reasoning"
	| "event";

export type CanonicalMessageRole = "user" | "assistant" | "developer" | "system" | "tool" | "unknown";

export interface CanonicalTextBlock {
	type: "text";
	text: string;
}

export interface CanonicalEvent {
	type: CanonicalEventType;
	message?: {
		role: CanonicalMessageRole;
		content: CanonicalTextBlock[];
	};
	tool_call?: {
		id: string | null;
		name: string | null;
		input: unknown;
	};
	tool_result?: {
		tool_call_id: string | null;
		output: unknown;
		is_error: boolean | null;
	};
	reasoning?: {
		content: string | null;
		summary: string[];
		encrypted_content: string | null;
	};
	event?: {
		name: string;
		data: unknown;
	};
	meta: {
		provider: string;
		schema: CanonicalSchema;
		timestamp: string | null;
		source_type: string;
		source_subtype: string | null;
		sequence: number;
	};
	provider_payload: unknown;
}

export interface TranscriptSource {
	adapterId: string;
	sourceId: string;
	path: string;
	providerSessionId: string | null;
	sessionKey: string;
}

export interface AdapterCheckpoint {
	sourceId: string;
	cursor: string;
	updatedAt?: string;
}

export interface AdapterDelta {
	source: TranscriptSource;
	cursor: string;
	canonicalEvents: CanonicalEvent[];
	rawLines: string[];
}

export interface TranscriptAdapter {
	id: string;
	detect(projectDir: string): Promise<TranscriptSource | null>;
	readDelta(
		source: TranscriptSource,
		checkpoint: AdapterCheckpoint | null,
	): Promise<AdapterDelta | null>;
	sourceFromHint?(hintPath: string, projectDir: string): Promise<TranscriptSource | null>;
}
