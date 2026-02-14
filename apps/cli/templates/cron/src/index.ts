import { Hono } from "hono";
import { cors } from "hono/cors";
import { runChecks } from "./monitor";
import { adminHTML } from "./admin";

type Bindings = {
	DB: D1Database;
	MONITOR_URLS?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("/*", cors());

app.get("/", (c) => {
	return c.html(adminHTML());
});

app.get("/health", (c) => {
	return c.json({ status: "ok", timestamp: Date.now() });
});

// Rich per-group uptime stats (URLs hidden)
app.get("/api/status", async (c) => {
	const db = c.env.DB;
	const now = Math.floor(Date.now() / 1000);
	const DAY = 86400;

	const { results: groups } = await db
		.prepare(
			`SELECT
				group_name,
				COUNT(DISTINCT url) as endpoint_count,
				MAX(created_at) as last_check_at,
				SUM(CASE WHEN created_at > ?1 THEN 1 ELSE 0 END) as checks_24h,
				SUM(CASE WHEN created_at > ?1 AND ok = 1 THEN 1 ELSE 0 END) as up_24h,
				SUM(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END) as checks_7d,
				SUM(CASE WHEN created_at > ?2 AND ok = 1 THEN 1 ELSE 0 END) as up_7d,
				COUNT(*) as checks_30d,
				SUM(ok) as up_30d,
				ROUND(AVG(CASE WHEN created_at > ?1 THEN latency_ms END)) as avg_latency,
				MIN(CASE WHEN created_at > ?1 THEN latency_ms END) as min_latency,
				MAX(CASE WHEN created_at > ?1 THEN latency_ms END) as max_latency
			FROM checks
			GROUP BY group_name
			ORDER BY group_name`,
		)
		.bind(now - DAY, now - 7 * DAY)
		.all();

	const monitors = await Promise.all(
		(groups as Array<Record<string, unknown>>).map(async (g) => {
			const groupName = g.group_name as string;

			// Recent checks for status bar + sparkline (newest first → reverse for display)
			const { results: recentRaw } = await db
				.prepare(
					"SELECT ok, latency_ms FROM checks WHERE group_name = ? ORDER BY created_at DESC LIMIT 48",
				)
				.bind(groupName)
				.all();
			const recent = (
				recentRaw as Array<{ ok: number; latency_ms: number }>
			).reverse();

			// Uptime streak: time since last failure (or since first check if none)
			const lastFail = (await db
				.prepare(
					"SELECT created_at FROM checks WHERE group_name = ? AND ok = 0 ORDER BY created_at DESC LIMIT 1",
				)
				.bind(groupName)
				.first()) as { created_at: number } | null;

			const firstCheck = (await db
				.prepare(
					"SELECT created_at FROM checks WHERE group_name = ? ORDER BY created_at ASC LIMIT 1",
				)
				.bind(groupName)
				.first()) as { created_at: number } | null;

			const streakStart = lastFail
				? lastFail.created_at
				: firstCheck
					? firstCheck.created_at
					: now;
			const streakSeconds = Math.max(0, now - streakStart);

			// Current status from latest check per URL
			const { results: latestPerUrl } = await db
				.prepare(
					`SELECT c.ok FROM checks c
					INNER JOIN (
						SELECT url, MAX(created_at) as max_ts
						FROM checks WHERE group_name = ? GROUP BY url
					) latest ON c.url = latest.url AND c.created_at = latest.max_ts
					WHERE c.group_name = ?`,
				)
				.bind(groupName, groupName)
				.all();

			const allUp =
				latestPerUrl.length > 0 &&
				latestPerUrl.every((r: Record<string, unknown>) => r.ok);

			function pct(up: number, total: number): number | null {
				return total > 0 ? Math.round((1000 * up) / total) / 10 : null;
			}

			return {
				group_name: groupName,
				endpoint_count: g.endpoint_count,
				all_up: allUp,
				streak_seconds: streakSeconds,
				last_check_at: g.last_check_at,
				periods: {
					"24h": {
						uptime_pct: pct(g.up_24h as number, g.checks_24h as number),
						failed_checks: (g.checks_24h as number) - (g.up_24h as number),
						total_checks: g.checks_24h,
					},
					"7d": {
						uptime_pct: pct(g.up_7d as number, g.checks_7d as number),
						failed_checks: (g.checks_7d as number) - (g.up_7d as number),
						total_checks: g.checks_7d,
					},
					"30d": {
						uptime_pct: pct(g.up_30d as number, g.checks_30d as number),
						failed_checks: (g.checks_30d as number) - (g.up_30d as number),
						total_checks: g.checks_30d,
					},
				},
				latency: {
					avg: g.avg_latency || 0,
					min: g.min_latency || 0,
					max: g.max_latency || 0,
				},
				recent_checks: recent,
			};
		}),
	);

	return c.json({ monitors });
});

// Recent checks (URLs hidden)
app.get("/api/checks", async (c) => {
	const db = c.env.DB;
	const { results } = await db
		.prepare(
			"SELECT id, group_name, status_code, latency_ms, ok, source, error, created_at FROM checks ORDER BY created_at DESC LIMIT 100",
		)
		.all();
	return c.json({ checks: results });
});

// Manual trigger
app.post("/api/trigger", async (c) => {
	const results = await runChecks(
		c.env.DB,
		c.env as unknown as Record<string, unknown>,
		"manual",
	);
	const allOk = results.every((r) => r.ok);
	return c.json({
		checked: results.length,
		all_ok: allOk,
		results: results.map((r) => ({
			group: r.group_name,
			ok: r.ok,
			latency_ms: r.latency_ms,
		})),
	});
});

// Cron handler
app.post("/__scheduled", async (c) => {
	const results = await runChecks(
		c.env.DB,
		c.env as unknown as Record<string, unknown>,
		"cron",
	);
	const allOk = results.every((r) => r.ok);
	console.log(`Uptime check: ${results.length} URLs, all_ok=${allOk}`);
	return c.json({ checked: results.length, all_ok: allOk });
});

export default app;
