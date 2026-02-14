export interface MonitorGroup {
	name: string;
	urls: string[];
}

export interface CheckResult {
	url: string;
	group_name: string;
	status_code: number | null;
	latency_ms: number;
	ok: boolean;
	error: string | null;
}

async function checkUrl(url: string): Promise<Omit<CheckResult, "group_name">> {
	const start = Date.now();
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
		return {
			url,
			status_code: res.status,
			latency_ms: Date.now() - start,
			ok: res.ok,
			error: null,
		};
	} catch (err) {
		return {
			url,
			status_code: null,
			latency_ms: Date.now() - start,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Parse MONITOR_URLS into named groups.
 *
 * Format: "GroupName=url1,url2;Other=url3,url4"
 * Plain URLs without a group name go into "Default".
 * If nothing is configured, monitors https://1.1.1.1 as "Default".
 */
export function parseMonitorConfig(env: Record<string, unknown>): MonitorGroup[] {
	const raw = env.MONITOR_URLS as string | undefined;
	if (!raw?.trim()) {
		return [{ name: "Default", urls: ["https://1.1.1.1"] }];
	}

	const groups: MonitorGroup[] = [];

	for (const segment of raw.split(";")) {
		const trimmed = segment.trim();
		if (!trimmed) continue;

		const eqIndex = trimmed.indexOf("=");
		if (eqIndex > 0) {
			const name = trimmed.slice(0, eqIndex).trim();
			const urls = trimmed
				.slice(eqIndex + 1)
				.split(",")
				.map((u) => u.trim())
				.filter(Boolean);
			if (urls.length) groups.push({ name, urls });
		} else {
			const urls = trimmed
				.split(",")
				.map((u) => u.trim())
				.filter(Boolean);
			const existing = groups.find((g) => g.name === "Default");
			if (existing) {
				existing.urls.push(...urls);
			} else if (urls.length) {
				groups.push({ name: "Default", urls });
			}
		}
	}

	if (groups.length === 0) {
		groups.push({ name: "Default", urls: ["https://1.1.1.1"] });
	}

	return groups;
}

export async function runChecks(
	db: D1Database,
	env: Record<string, unknown>,
	source: "cron" | "manual",
): Promise<CheckResult[]> {
	const groups = parseMonitorConfig(env);
	const promises: Promise<CheckResult>[] = [];

	for (const group of groups) {
		for (const url of group.urls) {
			promises.push(
				checkUrl(url).then((r) => ({ ...r, group_name: group.name })),
			);
		}
	}

	const results = await Promise.all(promises);

	for (const r of results) {
		await db
			.prepare(
				"INSERT INTO checks (id, url, group_name, status_code, latency_ms, ok, source, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				r.url,
				r.group_name,
				r.status_code,
				r.latency_ms,
				r.ok ? 1 : 0,
				source,
				r.error,
				Math.floor(Date.now() / 1000),
			)
			.run();
	}

	return results;
}
