import type { Bindings } from "./types";

type TailLog = { message?: unknown[]; level?: string; timestamp?: number };
type TailException = { name?: string; message?: string; timestamp?: number };
type TailEvent = {
	scriptName?: string | null;
	outcome?: string | null;
	eventTimestamp?: number | null;
	event?: {
		request?: { method?: string; url?: string };
	};
	logs?: TailLog[];
	exceptions?: TailException[];
	diagnosticsChannelEvents?: unknown[];
};

function sseData(payload: unknown): Uint8Array {
	const line = `data: ${JSON.stringify(payload)}\n\n`;
	return new TextEncoder().encode(line);
}

function normalizeTailEvent(ev: TailEvent): {
	type: "event";
	ts: number;
	outcome: string | null;
	request: { method?: string; url?: string } | null;
	logs: Array<{ ts: number | null; level: string | null; message: unknown[] }>;
	exceptions: Array<{ ts: number | null; name: string | null; message: string | null }>;
} | null {
	const logs = (ev.logs ?? [])
		.filter((l) => Array.isArray(l.message) && l.message.length > 0)
		.map((l) => ({
			ts: typeof l.timestamp === "number" ? l.timestamp : null,
			level: typeof l.level === "string" ? l.level : null,
			message: (l.message ?? []) as unknown[],
		}));

	const exceptions = (ev.exceptions ?? []).map((e) => ({
		ts: typeof e.timestamp === "number" ? e.timestamp : null,
		name: typeof e.name === "string" ? e.name : null,
		message: typeof e.message === "string" ? e.message : null,
	}));

	// Token-efficient default: drop "empty" events that contain neither logs nor exceptions.
	if (logs.length === 0 && exceptions.length === 0) {
		return null;
	}

	const ts =
		typeof ev.eventTimestamp === "number"
			? ev.eventTimestamp
			: typeof logs[0]?.ts === "number"
				? (logs[0].ts as number)
				: Date.now();

	const method = ev.event?.request?.method;
	const url = ev.event?.request?.url;

	return {
		type: "event",
		ts,
		outcome: typeof ev.outcome === "string" ? ev.outcome : null,
		request: method || url ? { method, url } : null,
		logs,
		exceptions,
	};
}

export class LogStreamDO {
	private readonly state: DurableObjectState;
	private readonly env: Bindings;
	private readonly clients = new Map<string, WritableStreamDefaultWriter<Uint8Array>>();
	private heartbeatTimer: number | null = null;

	constructor(state: DurableObjectState, env: Bindings) {
		this.state = state;
		this.env = env;
		void this.state.blockConcurrencyWhile(async () => {
			// No persistent state needed for MVP.
		});
	}

	private startHeartbeat() {
		if (this.heartbeatTimer !== null) return;
		this.heartbeatTimer = setInterval(() => {
			if (this.clients.size === 0) return;
			const bytes = sseData({ type: "heartbeat", ts: Date.now() });
			for (const [id, writer] of this.clients) {
				writer.write(bytes).catch(() => {
					this.clients.delete(id);
					try {
						writer.close();
					} catch {
						// Ignore close errors
					}
				});
			}
		}, 15_000) as unknown as number;
	}

	private stopHeartbeatIfIdle() {
		if (this.clients.size > 0) return;
		if (this.heartbeatTimer === null) return;
		clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private broadcast(payload: unknown) {
		if (this.clients.size === 0) return;
		const bytes = sseData(payload);
		for (const [id, writer] of this.clients) {
			writer.write(bytes).catch(() => {
				this.clients.delete(id);
				try {
					writer.close();
				} catch {
					// Ignore close errors
				}
			});
		}
	}

	private handleStream(request: Request): Response {
		const url = new URL(request.url);
		const sessionId = url.searchParams.get("session_id");
		const projectId = url.searchParams.get("project_id");
		const expiresAt = url.searchParams.get("expires_at");

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();
		const clientId = crypto.randomUUID();
		this.clients.set(clientId, writer);
		this.startHeartbeat();

		// Session banner (best-effort).
		void writer.write(
			sseData({
				type: "session",
				session_id: sessionId,
				project_id: projectId,
				expires_at: expiresAt,
			}),
		);

		// Cleanup on disconnect.
		const cleanup = () => {
			const w = this.clients.get(clientId);
			this.clients.delete(clientId);
			this.stopHeartbeatIfIdle();
			if (w) {
				try {
					w.close();
				} catch {
					// Ignore close errors
				}
			}
		};
		request.signal.addEventListener("abort", cleanup, { once: true });

		return new Response(readable, {
			headers: {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
			},
		});
	}

	private async handleIngest(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => null)) as { events?: TailEvent[] } | null;
		const events = Array.isArray(body?.events) ? body.events : [];

		for (const ev of events) {
			const normalized = normalizeTailEvent(ev);
			if (!normalized) continue;
			this.broadcast(normalized);
		}

		return new Response(null, { status: 204 });
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/stream") {
			return this.handleStream(request);
		}
		if (request.method === "POST" && url.pathname === "/ingest") {
			return this.handleIngest(request);
		}

		return new Response("Not found", { status: 404 });
	}
}
