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

interface Env {
	LOG_STREAM: DurableObjectNamespace;
}

function isEmptyEvent(ev: TailEvent): boolean {
	const logs = ev.logs ?? [];
	const exceptions = ev.exceptions ?? [];
	return logs.length === 0 && exceptions.length === 0;
}

export default {
	async fetch(): Promise<Response> {
		// No public HTTP surface for MVP.
		return new Response("Not found", { status: 404 });
	},

	async tail(events: TailEvent[], env: Env, ctx: ExecutionContext): Promise<void> {
		// Group by producer script name to route to the correct DO instance.
		const byScript = new Map<string, TailEvent[]>();
		for (const ev of events) {
			const scriptName = ev.scriptName;
			if (!scriptName || typeof scriptName !== "string") continue;
			if (isEmptyEvent(ev)) continue; // token-efficient default
			const list = byScript.get(scriptName) ?? [];
			list.push({
				scriptName,
				outcome: ev.outcome ?? null,
				eventTimestamp: ev.eventTimestamp ?? null,
				event: {
					request: {
						method: ev.event?.request?.method,
						url: ev.event?.request?.url,
					},
				},
				logs: ev.logs,
				exceptions: ev.exceptions,
			});
			byScript.set(scriptName, list);
		}

		if (byScript.size === 0) return;

		const tasks: Promise<Response>[] = [];
		for (const [scriptName, evs] of byScript) {
			const id = env.LOG_STREAM.idFromName(scriptName);
			const stub = env.LOG_STREAM.get(id);
			tasks.push(
				stub.fetch("http://do/ingest", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ events: evs }),
				}),
			);
		}

		ctx.waitUntil(Promise.allSettled(tasks));
	},
};

