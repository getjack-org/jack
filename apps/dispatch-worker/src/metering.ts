/**
 * Metering utilities for Analytics Engine data points.
 *
 * Data Point Schema (from PRD /docs/internal/metering-pricing.md):
 * - indexes: [project_id] - enables per-project sampling
 * - blobs (10 strings):
 *   1. org_id - billing aggregation
 *   2. tier - "free" | "pro" | "team"
 *   3. method - "GET" | "POST" | "PUT" | "DELETE" | etc.
 *   4. cache_status - "HIT" | "MISS" | "BYPASS" | "DYNAMIC"
 *   5. country - ISO country code
 *   6. continent - "NA" | "EU" | "AS" | etc.
 *   7. city - e.g., "San Francisco"
 *   8. region - e.g., "California"
 *   9. status_bucket - "2xx" | "3xx" | "4xx" | "5xx"
 *   10. pathname_bucket - bounded to ~50 unique values
 * - doubles (4 numbers):
 *   1. count - always 1
 *   2. response_time_ms - latency in milliseconds
 *   3. request_size_bytes - Content-Length of request
 *   4. response_size_bytes - Content-Length of response
 */

export function getStatusBucket(status: number): string {
	if (status < 300) return "2xx";
	if (status < 400) return "3xx";
	if (status < 500) return "4xx";
	return "5xx";
}

/**
 * Maps pathname to a bounded set of buckets to prevent cardinality explosion.
 * Limits to ~50 unique values for Analytics Engine efficiency.
 */
export function getPathnameBucket(pathname: string): string {
	if (pathname === "/") return "/";
	if (pathname === "/favicon.ico") return "/favicon.ico";
	if (pathname === "/robots.txt") return "/robots.txt";

	// Common framework paths
	if (pathname.startsWith("/api/")) return "/api/*";
	if (pathname.startsWith("/_next/")) return "/_next/*";
	if (pathname.startsWith("/static/")) return "/static/*";
	if (pathname.startsWith("/assets/")) return "/assets/*";
	if (pathname.startsWith("/public/")) return "/public/*";
	if (pathname.startsWith("/.well-known/")) return "/.well-known/*";

	// Match common file extensions
	if (/\.(js|mjs|cjs)$/i.test(pathname)) return "/*.js";
	if (/\.css$/i.test(pathname)) return "/*.css";
	if (/\.(png|jpg|jpeg|gif|svg|webp|ico|avif)$/i.test(pathname)) return "/*.img";
	if (/\.(woff|woff2|ttf|otf|eot)$/i.test(pathname)) return "/*.font";
	if (/\.json$/i.test(pathname)) return "/*.json";
	if (/\.(xml|rss|atom)$/i.test(pathname)) return "/*.xml";
	if (/\.(html|htm)$/i.test(pathname)) return "/*.html";

	return "/other";
}

/**
 * Extracts cache status from response headers.
 * Uses CF-Cache-Status header set by Cloudflare.
 */
export function getCacheStatus(response: Response): string {
	const cfCacheStatus = response.headers.get("cf-cache-status");
	if (cfCacheStatus === "HIT") return "HIT";
	if (cfCacheStatus === "MISS") return "MISS";
	if (cfCacheStatus === "BYPASS") return "BYPASS";
	if (cfCacheStatus === "EXPIRED") return "EXPIRED";
	if (cfCacheStatus === "STALE") return "STALE";
	if (cfCacheStatus === "REVALIDATED") return "REVALIDATED";
	return "DYNAMIC";
}

export interface MeteringContext {
	projectId: string;
	orgId: string;
	tier: string;
	request: Request;
	response: Response;
	startTime: number;
}

/**
 * Creates a data point for Analytics Engine.
 * Call this within ctx.waitUntil() for 0ms latency impact.
 */
export function createUsageDataPoint(ctx: MeteringContext): {
	indexes: string[];
	blobs: string[];
	doubles: number[];
} {
	const { projectId, orgId, tier, request, response, startTime } = ctx;
	const responseTimeMs = Date.now() - startTime;
	const url = new URL(request.url);

	// Extract CF geo data with fallbacks
	const cf = request.cf as
		| {
				country?: string;
				continent?: string;
				city?: string;
				region?: string;
		  }
		| undefined;

	return {
		indexes: [projectId],
		blobs: [
			orgId, // blob1
			tier, // blob2
			request.method, // blob3
			getCacheStatus(response), // blob4
			cf?.country ?? "unknown", // blob5
			cf?.continent ?? "unknown", // blob6
			cf?.city ?? "unknown", // blob7
			cf?.region ?? "unknown", // blob8
			getStatusBucket(response.status), // blob9
			getPathnameBucket(url.pathname), // blob10
		],
		doubles: [
			1, // double1: request count
			responseTimeMs, // double2: latency ms
			parseContentLength(request.headers.get("content-length")), // double3
			parseContentLength(response.headers.get("content-length")), // double4
		],
	};
}

function parseContentLength(value: string | null): number {
	if (!value) return 0;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : 0;
}
