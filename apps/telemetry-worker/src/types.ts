export interface TelemetryEvent {
	distinctId: string;
	event: string;
	properties?: Record<string, unknown>;
	timestamp?: number;
}

export interface IdentifyEvent {
	distinctId: string;
	properties: Record<string, unknown>;
	setOnce?: Record<string, unknown>;
}

export interface AliasEvent {
	distinctId: string;
	alias: string;
}

export interface Bindings {
	POSTHOG_API_KEY: string;
	RATE_LIMIT: KVNamespace;
}
