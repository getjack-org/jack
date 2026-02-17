import { verifyJwt } from "@getjack/auth";
import type { AuthContext, JwtPayload } from "@getjack/auth";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type Stripe from "stripe";
import { BillingService } from "./billing-service";
import {
	type AIUsageByModel,
	type AIUsageMetrics,
	CloudflareClient,
	type CloudflareCustomHostname,
	type D1QueryResult,
	type UsageByDimension,
	type UsageMetricsAE,
	getMimeType,
} from "./cloudflare-api";
import { CreditsService } from "./credits-service";
import { decryptSecretValue, decryptSecrets, isEncryptedEnvelope } from "./crypto";
import { DaimoBillingService } from "./daimo-billing-service";
import { DeploymentService, validateManifest } from "./deployment-service";
import { getDoEnforcementStatus, processDoMetering } from "./do-metering";
import { REFERRAL_CAP, TIER_LIMITS, computeLimits } from "./entitlements-config";
import { ProvisioningService, normalizeSlug, validateSlug } from "./provisioning";
import { ProjectCacheService } from "./repositories/project-cache-service";
import { validateReadOnly } from "./sql-utils";
import type {
	Bindings,
	CustomDomain,
	CustomDomainDnsInfo,
	CustomDomainNextStep,
	CustomDomainResponse,
	CustomDomainStatus,
	OrgBilling,
	PlanStatus,
	PlanTier,
	ProjectConfig,
	ProjectStatus,
	Resource,
} from "./types";
import { PAID_STATUSES } from "./types";
export { LogStreamDO } from "./log-stream-do";

// =====================================================
// Feature Gating
// =====================================================

interface GatingResult {
	allowed: boolean;
	error?: {
		code: string;
		message: string;
		upgrade_url: string;
	};
}

/**
 * Check if a billing record grants paid access.
 * Handles both Stripe (status-based) and Daimo (period-based with 3-day grace).
 */
function hasPaidAccess(billing: OrgBilling | null): boolean {
	if (!billing || billing.plan_tier === "free") return false;

	// For Daimo payments, check if within period + 3-day grace
	if (billing.payment_provider === "daimo") {
		if (!billing.current_period_end) return false;
		const periodEnd = new Date(billing.current_period_end);
		const gracePeriodEnd = new Date(periodEnd.getTime() + 3 * 24 * 60 * 60 * 1000);
		return new Date() < gracePeriodEnd;
	}

	// For Stripe, use status-based check
	return PAID_STATUSES.includes(billing.plan_status as PlanStatus);
}

/**
 * Check if an organization can create more custom domains based on their plan tier.
 * Returns { allowed: true } if within limits, or { allowed: false, error: {...} } if blocked.
 */
async function checkCustomDomainGate(
	db: D1Database,
	orgId: string,
	currentCount: number,
): Promise<GatingResult> {
	const billing = await db
		.prepare(
			"SELECT plan_tier, plan_status, payment_provider, current_period_end FROM org_billing WHERE org_id = ?",
		)
		.bind(orgId)
		.first<OrgBilling>();

	const tier = (billing?.plan_tier || "free") as PlanTier;

	// Sum ALL active credits (referrals + manual)
	const bonusResult = await db
		.prepare(
			"SELECT COALESCE(SUM(amount), 0) as total FROM credits WHERE org_id = ? AND status = 'active'",
		)
		.bind(orgId)
		.first<{ total: number }>();

	const limits = computeLimits(tier, bonusResult?.total ?? 0);

	// Check if status grants access
	const hasAccess = !billing || billing.plan_tier === "free" || hasPaidAccess(billing);

	if (!hasAccess || currentCount >= limits.custom_domains) {
		return {
			allowed: false,
			error: {
				code: "limit_exceeded",
				message: `Custom domain limit reached (${limits.custom_domains}). Refer friends to earn more.`,
				upgrade_url: "https://dash.getjack.org/pricing",
			},
		};
	}

	return { allowed: true };
}

type WorkosJwtPayload = JwtPayload & {
	org_id?: string;
};

// Username validation: 3-39 chars, lowercase alphanumeric + hyphens, must start/end with alphanumeric
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]{1,2}$/;
const ANALYTICS_CACHE_TTL_SECONDS = 600;

// Hostname validation for custom domains
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const RESERVED_TLDS = ["localhost", "local", "test", "invalid", "example"];
const BLOCKED_HOSTNAMES = ["runjack.xyz", "cloudflare.com"]; // TODO: re-add "getjack.org" after testing
const LOG_TAIL_WORKER_SERVICE = "log-worker";

// Statuses that consume a domain slot (any domain in verification/provisioning pipeline counts)
const SLOT_CONSUMING_STATUSES: CustomDomainStatus[] = [
	"pending_dns",
	"claimed",
	"unassigned",
	"pending",
	"pending_owner",
	"pending_ssl",
	"active",
];
const LOG_TAIL_DISPATCH_NAMESPACE = "jack-tenants";

function d1DatetimeToIso(value: string): string {
	// D1 CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC.
	if (value.includes("T")) return value;
	return `${value.replace(" ", "T")}Z`;
}

function validateUsername(username: string): string | null {
	if (!username || username.trim() === "") {
		return "Username cannot be empty";
	}

	if (username.length < 3) {
		return "Username must be at least 3 characters";
	}

	if (username.length > 39) {
		return "Username must be 39 characters or less";
	}

	if (username !== username.toLowerCase()) {
		return "Username must be lowercase";
	}

	if (!USERNAME_PATTERN.test(username)) {
		return "Username must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number";
	}

	// Reserved usernames - system, product, and well-known brands
	const reserved = [
		// System & infrastructure
		"admin",
		"api",
		"www",
		"mail",
		"cdn",
		"static",
		"assets",
		"system",
		"root",
		"support",
		"help",
		"security",
		// UI routes
		"account",
		"settings",
		"profile",
		"dashboard",
		"login",
		"logout",
		"explore",
		"trending",
		// Jack product
		"jack",
		"getjack",
		"templates",
		"template",
		// Cloud & infrastructure brands
		"vercel",
		"cloudflare",
		"netlify",
		"railway",
		"render",
		"supabase",
		"neon",
		"aws",
		"azure",
		"google",
		"github",
		"gitlab",
		// Farcaster ecosystem
		"farcaster",
		"warpcast",
		"neynar",
		"privy",
		// Big tech
		"microsoft",
		"apple",
		"meta",
		"facebook",
		"twitter",
		"x",
	];
	if (reserved.includes(username)) {
		return "This username is reserved. Please choose a different one.";
	}

	// Block jack-* prefix to prevent impersonation
	if (username.startsWith("jack-") || username.startsWith("getjack-")) {
		return "Usernames starting with 'jack-' are reserved. Please choose a different one.";
	}

	return null;
}

function validateHostname(hostname: string): string | null {
	if (!hostname || hostname.trim() === "") {
		return "Hostname cannot be empty";
	}

	const normalized = hostname.toLowerCase().trim();

	if (normalized.length > 253) {
		return "Hostname too long (max 253 characters)";
	}

	if (!HOSTNAME_PATTERN.test(normalized)) {
		return "Invalid hostname format. Must be a valid subdomain like api.example.com";
	}

	// Check for IP addresses
	if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
		return "IP addresses are not allowed. Use a domain name.";
	}

	// Check reserved TLDs
	const parts = normalized.split(".");
	const tld = parts[parts.length - 1];
	if (tld && RESERVED_TLDS.includes(tld)) {
		return `Reserved TLD "${tld}" is not allowed`;
	}

	// Check for apex domains (no subdomain)
	if (parts.length < 3) {
		return "Apex domains are not supported. Use a subdomain like api.example.com";
	}

	// Block Jack/Cloudflare hostnames
	for (const blocked of BLOCKED_HOSTNAMES) {
		if (normalized === blocked || normalized.endsWith(`.${blocked}`)) {
			return `Hostname ${blocked} is not allowed`;
		}
	}

	return null;
}

// Map Cloudflare status to Jack status
function mapCloudflareToJackStatus(
	cfStatus: string,
	sslStatus: string | undefined,
): CustomDomainStatus {
	switch (cfStatus) {
		case "pending":
			return "pending_owner";
		case "active":
			if (sslStatus === "active") {
				return "active";
			}
			return "pending_ssl";
		case "blocked":
			return "blocked";
		case "moved":
			return "moved";
		case "deleted":
		case "pending_deletion":
			return "deleting";
		default:
			return "pending";
	}
}

// =====================================================
// DNS Verification
// =====================================================

const EXPECTED_DNS_TARGET = "runjack.xyz";

function normalizeDnsName(name: string): string {
	return name.toLowerCase().replace(/\.$/, "");
}

interface DnsVerificationResult {
	verified: boolean;
	target: string | null;
	error: string | null;
}

async function verifyDns(hostname: string): Promise<DnsVerificationResult> {
	try {
		const response = await fetch(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`,
			{ headers: { Accept: "application/dns-json" } },
		);
		if (!response.ok) {
			return { verified: false, target: null, error: `DNS lookup failed: ${response.status}` };
		}
		const data = (await response.json()) as { Status: number; Answer?: Array<{ data: string }> };
		const firstAnswer = data.Answer?.[0];
		if (firstAnswer) {
			const rawTarget = firstAnswer.data;
			const target = normalizeDnsName(rawTarget);
			const verified = target === normalizeDnsName(EXPECTED_DNS_TARGET);
			return {
				verified,
				target,
				error: verified ? null : `Points to ${target}, expected ${EXPECTED_DNS_TARGET}`,
			};
		}
		if (data.Status === 3) {
			return {
				verified: false,
				target: null,
				error: "Domain not found (NXDOMAIN) - check hostname spelling",
			};
		}
		return {
			verified: false,
			target: null,
			error: `No CNAME record found - add CNAME pointing to ${EXPECTED_DNS_TARGET}`,
		};
	} catch (err) {
		return {
			verified: false,
			target: null,
			error: err instanceof Error ? err.message : "DNS lookup failed",
		};
	}
}

// Get next step guidance for a domain based on its current status
function getNextStep(domain: CustomDomain): CustomDomainNextStep | undefined {
	switch (domain.status) {
		case "claimed":
			return {
				action: "none",
				message: "Assign to a project: jack domain assign <hostname> <project>",
			};
		case "unassigned":
			return {
				action: "none",
				message: "Ready to assign: jack domain assign <hostname> <project>",
			};
		case "pending_dns":
			return {
				action: "add_cname",
				record_type: "CNAME",
				record_name: domain.hostname.split(".").slice(0, -2).join(".") || "@",
				record_value: EXPECTED_DNS_TARGET,
				message: `Add a CNAME record pointing to ${EXPECTED_DNS_TARGET}`,
			};
		case "pending_owner":
			return domain.ownership_verification_name
				? {
						action: "add_txt",
						record_type: "TXT",
						record_name: domain.ownership_verification_name,
						record_value: domain.ownership_verification_value!,
						message: "Add a TXT record to verify domain ownership",
					}
				: { action: "wait", message: "Verifying domain ownership..." };
		case "pending_ssl":
			return { action: "wait", message: "Issuing SSL certificate..." };
		case "active":
			return { action: "none", message: "Domain is working!" };
		case "moved":
			return { action: "delete", message: "DNS changed. Delete and re-add domain to restore." };
		case "expired":
			return { action: "delete", message: "Domain expired after 7 days. Delete to free hostname." };
		case "blocked":
		case "failed":
			return { action: "delete", message: "Delete and re-add domain to retry." };
		default:
			return undefined;
	}
}

// Format domain for API response
function formatDomainResponse(domain: CustomDomain): CustomDomainResponse {
	const response: CustomDomainResponse = {
		id: domain.id,
		hostname: domain.hostname,
		status: domain.status,
		ssl_status: domain.ssl_status,
		created_at: d1DatetimeToIso(domain.created_at),
	};

	// Include verification instructions if pending
	if (domain.status === "pending_owner" || domain.status === "pending_ssl") {
		response.verification = {
			type: "cname",
			target: EXPECTED_DNS_TARGET,
			instructions: `Add CNAME record: ${domain.hostname} -> ${EXPECTED_DNS_TARGET}`,
		};

		// Include ownership verification (TXT record) if present
		if (
			domain.ownership_verification_type &&
			domain.ownership_verification_name &&
			domain.ownership_verification_value
		) {
			response.ownership_verification = {
				type: domain.ownership_verification_type as "txt",
				name: domain.ownership_verification_name,
				value: domain.ownership_verification_value,
			};
		}
	}

	// Include DNS verification info
	const dnsInfo: CustomDomainDnsInfo = {
		verified: domain.dns_verified === 1,
		checked_at: domain.dns_last_checked_at ? d1DatetimeToIso(domain.dns_last_checked_at) : null,
		current_target: domain.dns_target,
		expected_target: EXPECTED_DNS_TARGET,
		error: domain.dns_error,
	};
	response.dns = dnsInfo;

	// Include next step guidance
	const nextStep = getNextStep(domain);
	if (nextStep) {
		response.next_step = nextStep;
	}

	// Include validation errors if present
	if (domain.validation_errors) {
		try {
			response.validation_errors = JSON.parse(domain.validation_errors);
		} catch {
			response.validation_errors = [domain.validation_errors];
		}
	}

	if (domain.updated_at) {
		response.updated_at = d1DatetimeToIso(domain.updated_at);
	}

	return response;
}

const app = new Hono<{ Bindings: Bindings }>();

app.use(
	"/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
	}),
);

app.get("/health", (c) => {
	return c.json({ status: "ok", service: "jack-control" });
});

// Public key for client-side secrets encryption (no auth required)
app.get("/v1/encryption-key", (c) => {
	return c.json(
		{
			kid: "v1",
			algorithm: "RSA-OAEP-256",
			key: {
				alg: "RSA-OAEP-256",
				e: "AQAB",
				ext: true,
				key_ops: ["encrypt"],
				kty: "RSA",
				n: "q2Y4K6heGkv_ABFOYokNXcwHFLAG3JScxEhjnZQTi7K8JEdCM9inqcy3gGhtT4lP6YWqhF4IHRMFU4qhPuByLASNp3bMWzDDKlckyDeWyPRnJqjb6IvwPYLw0ky1WumjjypAX_OSpNKhuYHx1X1hu7KQq9oa3f6sHFM5XbofMM2f__HvcEHnBVgkJvjTL2dn94DPgnsmtTLSRUAde34DQnXAKjVJ2jDuoC_sDAUmcmsEZKt3AUaCTkLBtbfW-ZI6_4VD2yNw-ySuOEprhhsNi6UpbjPY1ncduB5nkNhb276kVsjWo8w89KvDlhNCRyyZ_c0QRYSxn-nYEIE3vtS_h9FC9keMcDnH_fE4VPn14cjPV_G-eiUAoow8q5qBnFEp9DaaOswZ8IwEhpaxN6jvgk1WikZIBd58WB4HHSFWQ-W-096_5FA4cltQE7Qgwy86AgPnhpuCLLTqwpx8XF3GLbWtt9h4QYpfjrLyGuj4gJWCI4AJSDY1bvqiZtTfO1LdhyiZteEH0XhSBvXjXb1dJHbNXIcrIa_owtfEKqb53AxxwTvPaZazkigT0MqZ-141e7x6kuDkG_gSSFyCGrESaAyGYRh2K4wcGuV4jyZlQ6dzbQd0DPn8uRW3kC_vpToyZxZVqWGXFD6TtMYQwo_zWK3IaYCYMB-TYBFJj8a41z8",
			},
		},
		200,
		{ "Cache-Control": "public, max-age=86400" },
	);
});

// Feedback endpoint - no auth required
app.post("/v1/feedback", async (c) => {
	// Rate limit by IP
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	const { success } = await c.env.FEEDBACK_LIMITER.limit({ key: ip });
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many feedback submissions. Try again in a minute." },
			429,
		);
	}

	const body = await c.req.json<{
		message: string;
		email?: string | null;
		metadata?: {
			jack_version?: string;
			os?: string;
			project_name?: string | null;
			deploy_mode?: string | null;
		};
	}>();

	// Validate message
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "invalid_request", message: "Message is required" }, 400);
	}

	const message = body.message.trim();
	if (message.length === 0) {
		return c.json({ error: "invalid_request", message: "Message cannot be empty" }, 400);
	}

	if (message.length > 10000) {
		return c.json({ error: "invalid_request", message: "Message too long (max 10000 chars)" }, 400);
	}

	// Extract metadata
	const metadata = body.metadata ?? {};
	const feedbackId = `fb_${crypto.randomUUID()}`;

	try {
		await c.env.DB.prepare(
			`INSERT INTO feedback (id, message, email, jack_version, os, project_name, deploy_mode)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				feedbackId,
				message,
				body.email ?? null,
				metadata.jack_version ?? null,
				metadata.os ?? null,
				metadata.project_name ?? null,
				metadata.deploy_mode ?? null,
			)
			.run();

		return c.json({ success: true, id: feedbackId }, 201);
	} catch (error) {
		console.error("Failed to store feedback:", error);
		return c.json({ error: "internal_error", message: "Failed to store feedback" }, 500);
	}
});

// Username availability check - no auth required for UX
app.get("/v1/usernames/:name/available", async (c) => {
	// Rate limit by IP
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	const { success } = await c.env.USERNAME_CHECK_LIMITER.limit({ key: ip });
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many requests. Try again in a minute." },
			429,
		);
	}

	const name = c.req.param("name");

	// Validate username format
	const validationError = validateUsername(name);
	if (validationError) {
		return c.json({ available: false, username: name, error: validationError }, 200);
	}

	// Check if username exists
	const existing = await c.env.DB.prepare("SELECT id FROM users WHERE username = ?")
		.bind(name)
		.first<{ id: string }>();

	return c.json({
		available: !existing,
		username: name,
	});
});

// Registration endpoint - called by CLI after login to sync user info
app.post("/v1/register", async (c) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json({ error: "unauthorized", message: "Missing Authorization header" }, 401);
	}

	const token = authHeader.slice(7);
	let payload: WorkosJwtPayload;
	try {
		payload = (await verifyJwt(token)) as WorkosJwtPayload;
	} catch (error) {
		const message = error instanceof Error ? error.message : "Token verification failed";
		return c.json({ error: "unauthorized", message }, 401);
	}

	if (!payload.sub) {
		return c.json({ error: "invalid_token", message: "Missing subject in token" }, 400);
	}

	// Get user info from request body (provided by CLI from token response)
	const body = await c.req.json<{ email: string; first_name?: string; last_name?: string }>();
	if (!body.email) {
		return c.json({ error: "invalid_request", message: "Email is required" }, 400);
	}

	// Create or update user
	const existing = await c.env.DB.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	const userId = existing?.id ?? `usr_${crypto.randomUUID()}`;

	await c.env.DB.prepare(
		`INSERT INTO users (id, workos_user_id, email, first_name, last_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workos_user_id) DO UPDATE SET
       email = excluded.email,
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(userId, payload.sub, body.email, body.first_name ?? null, body.last_name ?? null)
		.run();

	// Ensure personal org exists
	const org = await ensureOrgForUser(c.env.DB, userId, payload);

	return c.json({
		user: { id: userId, email: body.email, first_name: body.first_name, last_name: body.last_name },
		org: { id: org.orgId, workos_org_id: org.workosOrgId },
	});
});

const api = new Hono<{ Bindings: Bindings }>();

api.use("/*", async (c, next) => {
	const authHeader = c.req.header("Authorization");
	if (!authHeader?.startsWith("Bearer ")) {
		return c.json(
			{ error: "unauthorized", message: "Missing or invalid Authorization header" },
			401,
		);
	}

	const token = authHeader.slice(7);
	try {
		const auth = await verifyAuth(token, c.env.DB);
		c.set("auth", auth);
		await next();
	} catch (error) {
		const message = error instanceof Error ? error.message : "Token verification failed";
		return c.json({ error: "unauthorized", message }, 401);
	}
});

api.get("/me", async (c) => {
	const auth = c.get("auth");
	const user = await c.env.DB.prepare(
		"SELECT id, email, first_name, last_name, username, created_at, updated_at FROM users WHERE id = ?",
	)
		.bind(auth.userId)
		.first();
	const org = await c.env.DB.prepare(
		"SELECT id, name, workos_org_id, created_at, updated_at FROM orgs WHERE id = ?",
	)
		.bind(auth.orgId)
		.first();

	return c.json({ auth, user, org });
});

api.put("/me/username", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{ username: string }>();

	if (!body.username) {
		return c.json({ error: "invalid_request", message: "Username is required" }, 400);
	}

	// Validate username format
	const validationError = validateUsername(body.username);
	if (validationError) {
		return c.json({ error: "invalid_request", message: validationError }, 400);
	}

	// Check if user already has a username
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	if (user?.username) {
		return c.json(
			{ error: "conflict", message: "Username already set. Contact support to change it." },
			409,
		);
	}

	// Try to set username (UNIQUE constraint will catch races)
	try {
		await c.env.DB.prepare(
			"UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
			.bind(body.username, auth.userId)
			.run();

		// Backfill owner_username for existing projects in user's orgs that don't have one set
		await c.env.DB.prepare(
			`UPDATE projects SET owner_username = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE org_id = ? AND owner_username IS NULL AND status != 'deleted'`,
		)
			.bind(body.username, auth.orgId)
			.run();

		// Update org name to username if it's a personal org with default name
		// Only update if: 1) not a WorkOS team org, 2) has default "'s Workspace" suffix
		await c.env.DB.prepare(
			`UPDATE orgs SET name = ?, updated_at = CURRENT_TIMESTAMP
			 WHERE id = ? AND workos_org_id IS NULL AND name LIKE '%''s Workspace'`,
		)
			.bind(body.username, auth.orgId)
			.run();

		return c.json({ success: true, username: body.username });
	} catch (error) {
		// Handle UNIQUE constraint violation
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("UNIQUE constraint") || message.includes("users.username")) {
			return c.json({ error: "conflict", message: "Username is already taken" }, 409);
		}
		throw error;
	}
});

// --- API Token Management ---

api.post("/tokens", async (c) => {
	const auth = c.get("auth");
	if (!auth.orgId) {
		return c.json({ error: "no_org", message: "No organization found" }, 403);
	}

	const body = await c.req.json<{ name: string; expires_in_days?: number }>();

	const name = body.name?.trim();
	if (!name || name.length > 64) {
		return c.json({ error: "invalid_name", message: "Name is required (1-64 chars)" }, 400);
	}

	const randomBytes = new Uint8Array(32);
	crypto.getRandomValues(randomBytes);
	const hexSecret = Array.from(randomBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	const rawToken = `jkt_${hexSecret}`;
	const idPrefix = hexSecret.slice(0, 8);
	const tokenHash = await hashToken(rawToken);

	const tokenId = `tok_${crypto.randomUUID()}`;
	const expiresAt = body.expires_in_days
		? new Date(Date.now() + body.expires_in_days * 86400000).toISOString()
		: null;

	await c.env.DB.prepare(
		`INSERT INTO api_tokens (id, user_id, org_id, name, token_hash, id_prefix, expires_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(tokenId, auth.userId, auth.orgId, name, tokenHash, idPrefix, expiresAt)
		.run();

	return c.json(
		{
			token: rawToken,
			id: tokenId,
			name,
			created_at: new Date().toISOString(),
			expires_at: expiresAt,
		},
		201,
	);
});

api.get("/tokens", async (c) => {
	const auth = c.get("auth");
	if (!auth.orgId) {
		return c.json({ error: "no_org", message: "No organization found" }, 403);
	}

	const { results } = await c.env.DB.prepare(
		`SELECT id, name, id_prefix, created_at, last_used_at, expires_at
		 FROM api_tokens WHERE org_id = ? AND revoked_at IS NULL
		 ORDER BY created_at DESC`,
	)
		.bind(auth.orgId)
		.all();

	return c.json({ tokens: results });
});

api.delete("/tokens/:id", async (c) => {
	const auth = c.get("auth");
	const tokenId = c.req.param("id");

	if (!auth.orgId) {
		return c.json({ error: "no_org", message: "No organization found" }, 403);
	}

	const token = await c.env.DB.prepare(
		"SELECT id FROM api_tokens WHERE id = ? AND org_id = ? AND revoked_at IS NULL",
	)
		.bind(tokenId, auth.orgId)
		.first();

	if (!token) {
		return c.json({ error: "not_found", message: "Token not found" }, 404);
	}

	await c.env.DB.prepare("UPDATE api_tokens SET revoked_at = datetime('now') WHERE id = ?")
		.bind(tokenId)
		.run();

	return c.json({ revoked: true, id: tokenId });
});

api.get("/orgs", async (c) => {
	const auth = c.get("auth");
	const result = await c.env.DB.prepare(
		`SELECT orgs.id, orgs.name, orgs.workos_org_id, org_memberships.role
     FROM orgs
     JOIN org_memberships ON orgs.id = org_memberships.org_id
     WHERE org_memberships.user_id = ?
     ORDER BY org_memberships.created_at ASC`,
	)
		.bind(auth.userId)
		.all();

	return c.json({ orgs: result.results });
});

api.get("/orgs/:orgId", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");
	const org = await c.env.DB.prepare(
		`SELECT orgs.id, orgs.name, orgs.workos_org_id, org_memberships.role
     FROM orgs
     JOIN org_memberships ON orgs.id = org_memberships.org_id
     WHERE orgs.id = ? AND org_memberships.user_id = ?`,
	)
		.bind(orgId, auth.userId)
		.first();

	if (!org) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	return c.json({ org });
});

// Slug availability check (per-org, not global)
api.get("/slugs/:slug/available", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	// Validate slug format first
	const slugError = validateSlug(slug);
	if (slugError) {
		return c.json({ available: false, error: slugError }, 200);
	}

	// Check if slug exists for this user's org (not globally)
	// Each user can have their own "my-app" since URLs are namespaced: username-slug.runjack.xyz
	const existing = await c.env.DB.prepare(
		"SELECT id FROM projects WHERE slug = ? AND org_id = ? AND status != 'deleted'",
	)
		.bind(slug, auth.orgId)
		.first<{ id: string }>();

	return c.json({
		available: !existing,
		slug,
	});
});

// Project endpoints
api.post("/projects", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{
		name: string;
		slug?: string;
		content_bucket?: boolean;
		use_prebuilt?: boolean;
		template?: string;
		forked_from?: string;
	}>();

	if (!body.name) {
		return c.json({ error: "invalid_request", message: "Name is required" }, 400);
	}

	// Validate or normalize slug
	let slug: string | undefined;
	if (body.slug !== undefined) {
		// User provided a slug - validate it strictly
		const slugError = validateSlug(body.slug);
		if (slugError) {
			return c.json({ error: "invalid_request", message: slugError }, 400);
		}
		slug = body.slug;
	} else {
		// Auto-generate from name - normalize it
		const normalized = normalizeSlug(body.name);
		if (normalized === "") {
			return c.json(
				{
					error: "invalid_request",
					message: "Project name must contain at least one alphanumeric character",
				},
				400,
			);
		}
		slug = normalized;
	}

	// Fetch user's username for URL construction
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	const provisioning = new ProvisioningService(c.env);
	try {
		const result = await provisioning.createProject(
			auth.orgId!,
			body.name,
			slug,
			body.content_bucket ?? false,
			user?.username ?? undefined,
			body.forked_from,
		);

		// Construct URL with username if available
		const url = user?.username
			? `https://${user.username}-${result.project.slug}.runjack.xyz`
			: `https://${result.project.slug}.runjack.xyz`;

		// If pre-built deployment is requested, attempt it
		if (body.use_prebuilt && body.template) {
			const cliVersion = c.req.header("X-Jack-Version") || "latest";
			try {
				const deploymentService = new DeploymentService(c.env);
				await deploymentService.deployFromPrebuiltTemplate(
					result.project.id,
					result.project.slug,
					body.template,
					cliVersion,
				);
				// Return with live status and URL
				return c.json(
					{
						...result,
						status: "live",
						url,
					},
					201,
				);
			} catch (error) {
				// Pre-built deploy failed - return result with prebuilt_failed flag
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				console.error("Pre-built deploy failed:", {
					template: body.template,
					cliVersion,
					projectId: result.project.id,
					error: errorMessage,
					stack: errorStack,
				});
				return c.json(
					{
						...result,
						url,
						prebuilt_failed: true,
						prebuilt_error: errorMessage,
					},
					201,
				);
			}
		}

		return c.json({ ...result, url }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Project creation failed";
		if (message.includes("already exists") || message.includes("projects.slug")) {
			return c.json({ error: "conflict", message }, 409);
		}
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects", async (c) => {
	const auth = c.get("auth");
	const provisioning = new ProvisioningService(c.env);
	const projects = await provisioning.listProjectsByOrg(auth.orgId!);
	return c.json({ projects });
});

api.get("/projects/by-slug/:slug", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	// Find project by slug within user's orgs
	const project = await c.env.DB.prepare(
		`SELECT p.id, p.org_id, p.name, p.slug, p.status, p.owner_username, p.tags, p.created_at, p.updated_at
		 FROM projects p
		 JOIN org_memberships om ON p.org_id = om.org_id
		 WHERE p.slug = ? AND om.user_id = ? AND p.status != 'deleted'`,
	)
		.bind(slug, auth.userId)
		.first();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	return c.json({ project });
});

api.get("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Construct URL with owner_username if available
	const url = project.owner_username
		? `https://${project.owner_username}-${project.slug}.runjack.xyz`
		: `https://${project.slug}.runjack.xyz`;

	return c.json({ project, url });
});

// GET /v1/projects/:projectId/overview - Unified project overview (project + resources + latest deployment + crons)
api.get("/projects/:projectId/overview", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Single query: project + auth check via JOIN
	const project = await c.env.DB.prepare(
		`SELECT p.id, p.org_id, p.name, p.slug, p.status, p.owner_username, p.tags, p.created_at, p.updated_at
		 FROM projects p
		 JOIN org_memberships om ON p.org_id = om.org_id
		 WHERE p.id = ? AND om.user_id = ? AND p.status != 'deleted'`,
	)
		.bind(projectId, auth.userId)
		.first<{
			id: string;
			org_id: string;
			name: string;
			slug: string;
			status: string;
			owner_username: string | null;
			tags: string;
			created_at: string;
			updated_at: string;
		}>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Batch: resources + latest deployment + crons in a single D1 round trip
	const [resourcesResult, deploymentResult, cronsResult] = await c.env.DB.batch([
		c.env.DB.prepare(
			`SELECT id, resource_type, resource_name, binding_name, provider_id, status, created_at
			 FROM resources WHERE project_id = ?`,
		).bind(projectId),
		c.env.DB.prepare(
			`SELECT id, status, source, error_message, message, created_at, updated_at
			 FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`,
		).bind(projectId),
		c.env.DB.prepare(
			`SELECT id, expression, expression_normalized, enabled, is_running, next_run_at,
			        last_run_at, last_run_status, last_run_duration_ms, consecutive_failures, created_at
			 FROM cron_schedules WHERE project_id = ? ORDER BY created_at DESC`,
		).bind(projectId),
	]);

	// Format resources
	const resourceRows = (resourcesResult?.results ?? []) as Array<Record<string, unknown>>;
	const resources = resourceRows.map((r) => ({
		id: r.id as string,
		resource_type: r.resource_type as string,
		resource_name: r.resource_name as string,
		binding_name: (r.binding_name as string | null) ?? null,
		provider_id: r.provider_id as string,
		status: r.status as string,
		created_at: r.created_at as string,
	}));

	// Format latest deployment
	const deployRows = (deploymentResult?.results ?? []) as Array<Record<string, unknown>>;
	const latestDep = deployRows[0] as Record<string, unknown> | undefined;
	const latest_deployment = latestDep
		? {
				id: latestDep.id as string,
				status: latestDep.status as string,
				source: latestDep.source as string,
				error_message: (latestDep.error_message as string | null) ?? null,
				message: (latestDep.message as string | null) ?? null,
				created_at: d1DatetimeToIso(latestDep.created_at as string),
				updated_at: d1DatetimeToIso(latestDep.updated_at as string),
			}
		: null;

	// Format crons with human-readable descriptions
	const cronRows = (cronsResult?.results ?? []) as Array<Record<string, unknown>>;
	let crons: Array<Record<string, unknown>> = [];
	if (cronRows.length > 0) {
		const cronstrue = await import("cronstrue");
		crons = cronRows.map((s) => {
			let description: string;
			try {
				description = cronstrue.toString(s.expression_normalized as string);
			} catch {
				description = s.expression_normalized as string;
			}
			return {
				id: s.id as string,
				expression: s.expression as string,
				description,
				enabled: (s.enabled as number) === 1,
				is_running: (s.is_running as number) === 1,
				next_run_at: s.next_run_at as string,
				last_run_at: s.last_run_at as string | null,
				last_run_status: s.last_run_status as string | null,
				last_run_duration_ms: s.last_run_duration_ms as number | null,
				consecutive_failures: s.consecutive_failures as number,
				created_at: s.created_at as string,
			};
		});
	}

	// Construct URL
	const url = project.owner_username
		? `https://${project.owner_username}-${project.slug}.runjack.xyz`
		: `https://${project.slug}.runjack.xyz`;

	// Parse tags
	let tags: string[] = [];
	try {
		tags = JSON.parse(project.tags || "[]");
	} catch {
		tags = [];
	}

	return c.json({
		project: {
			id: project.id,
			name: project.name,
			slug: project.slug,
			status: project.status,
			url,
			tags,
			created_at: project.created_at,
			updated_at: project.updated_at,
		},
		resources,
		latest_deployment,
		crons,
	});
});

api.get("/projects/:projectId/resources", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const resources = await provisioning.getProjectResources(projectId);
	return c.json({ resources });
});

api.get("/projects/:projectId/usage", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check cache first (5 min TTL for detailed analytics)
	const cacheKey = `ae:project:${projectId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);

		// Fetch all metrics in parallel
		const [metrics, byCountry, byPath, byMethod, byCacheStatus] = await Promise.all([
			cfClient.getProjectUsageFromAE(projectId, range.from, range.to),
			cfClient.getProjectTrafficByCountry(projectId, range.from, range.to),
			cfClient.getProjectTrafficByPath(projectId, range.from, range.to),
			cfClient.getProjectTrafficByMethod(projectId, range.from, range.to),
			cfClient.getProjectCacheBreakdown(projectId, range.from, range.to),
		]);

		const response = {
			project_id: projectId,
			range,
			metrics,
			breakdown: {
				by_country: byCountry,
				by_path: byPath,
				by_method: byMethod,
				by_cache_status: byCacheStatus,
			},
		};

		// Cache for 5 minutes
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Durable Objects usage per project (queries AE directly, same pattern as /usage)
api.get("/projects/:projectId/do-usage", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check KV cache (2 min TTL for DO usage)
	const cacheKey = `ae:do:project:${projectId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const doUsage = await cfClient.getProjectDoUsageFromAE(projectId, range.from, range.to);

		// Get enforcement status (fail gracefully — don't break usage data)
		let enforcementInfo: {
			enforced: boolean;
			enforced_at: string | null;
			enforced_reason: string | null;
		} = {
			enforced: false,
			enforced_at: null,
			enforced_reason: null,
		};
		try {
			const enforcement = await getDoEnforcementStatus(c.env.DB, projectId);
			if (enforcement) {
				enforcementInfo = {
					enforced: enforcement.enforced,
					enforced_at: enforcement.enforced_at,
					enforced_reason: enforcement.enforced_reason,
				};
			}
		} catch (e) {
			console.error("Failed to fetch DO enforcement status:", e);
		}

		const response = {
			project_id: projectId,
			range,
			...doUsage,
			enforcement: enforcementInfo,
		};

		// Cache for 2 minutes
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 120,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "DO usage query failed";
		console.error("DO usage query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Org-level Analytics Engine usage
api.get("/orgs/:orgId/usage", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(orgId, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	const cacheKey = `ae:org:${orgId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const [metrics, byProject] = await Promise.all([
			cfClient.getOrgUsageFromAE(orgId, range.from, range.to),
			cfClient.getOrgUsageByProjectFromAE(orgId, range.from, range.to),
		]);

		const response = {
			org_id: orgId,
			range,
			metrics,
			by_project: byProject,
		};

		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Project-level AI usage (tokens, models)
api.get("/projects/:projectId/ai-usage", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check cache first
	const cacheKey = `ae:ai:project:${projectId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const { metrics, by_model } = await cfClient.getProjectAIUsage(projectId, range.from, range.to);

		const response = {
			project_id: projectId,
			range,
			ai_metrics: metrics,
			by_model,
		};

		// Cache for 5 minutes
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("AI Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Org-level AI usage (tokens, models across all projects)
api.get("/orgs/:orgId/ai-usage", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(orgId, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	const cacheKey = `ae:ai:org:${orgId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const { metrics, by_model } = await cfClient.getOrgAIUsage(orgId, range.from, range.to);

		const response = {
			org_id: orgId,
			range,
			ai_metrics: metrics,
			by_model,
		};

		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("AI Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// Project-level Vectorize usage (operations, indexes)
api.get("/projects/:projectId/vectorize-usage", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const rangeResult = resolveAnalyticsRange(c);

	if (!rangeResult.ok) {
		return c.json({ error: "invalid_request", message: rangeResult.message }, 400);
	}

	const { range } = rangeResult;
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const cacheKey = `ae:vec:project:${projectId}:${range.from}:${range.to}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const { metrics, by_index, by_operation } = await cfClient.getProjectVectorizeUsage(
			projectId,
			range.from,
			range.to,
		);

		const response = {
			project_id: projectId,
			range,
			vectorize_metrics: metrics,
			by_index,
			by_operation,
		};

		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), {
			expirationTtl: 300,
		});

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Analytics query failed";
		console.error("Vectorize Analytics Engine query error:", error);
		return c.json({ error: "upstream_error", message }, 502);
	}
});

// ==================== BILLING ROUTES ====================

// GET /v1/orgs/:orgId/billing - Get billing status with entitlements
api.get("/orgs/:orgId/billing", async (c) => {
	const auth = c.get("auth");
	const orgId = c.req.param("orgId");

	// Verify membership
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(orgId, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Org not found" }, 404);
	}

	const billingService = new BillingService(c.env);
	const creditsService = new CreditsService(c.env);
	const billing = await billingService.getOrCreateBilling(orgId);

	// Count slot-consuming custom domains for this org (all domains in pipeline count)
	const placeholders = SLOT_CONSUMING_STATUSES.map(() => "?").join(",");
	const domainsResult = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM custom_domains
		 WHERE org_id = ? AND status IN (${placeholders})`,
	)
		.bind(orgId, ...SLOT_CONSUMING_STATUSES)
		.first<{ count: number }>();

	// Get referral stats (for display) and total bonus domains (for limits)
	const referrals = await creditsService.getReferrals(orgId);
	const totalBonusDomains = await creditsService.getTotalBonusDomains(orgId);
	const limits = computeLimits(billing.plan_tier as PlanTier, totalBonusDomains);

	return c.json({
		plan: {
			tier: billing.plan_tier,
			is_paid: billingService.isPaidTier(billing),
		},
		referrals: {
			code: referrals.code,
			successful: referrals.successful,
			pending: referrals.pending,
			cap: REFERRAL_CAP.custom_domains,
		},
		limits: {
			custom_domains: {
				limit: limits.custom_domains,
				used: domainsResult?.count ?? 0,
			},
		},
	});
});

// POST /v1/billing/checkout - Create Stripe checkout session
api.post("/billing/checkout", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{
		price_id: string;
		success_url: string;
		cancel_url: string;
	}>();

	if (!body.price_id || !body.success_url || !body.cancel_url) {
		return c.json(
			{ error: "invalid_request", message: "price_id, success_url, and cancel_url are required" },
			400,
		);
	}

	const billingService = new BillingService(c.env);

	// Get user and org info
	const user = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ email: string }>();
	const org = await c.env.DB.prepare("SELECT id, name FROM orgs WHERE id = ?")
		.bind(auth.orgId)
		.first<{ id: string; name: string }>();

	if (!user || !org) {
		return c.json({ error: "not_found", message: "User or org not found" }, 404);
	}

	try {
		// Check if org already has an active subscription - redirect to portal instead
		const billing = await billingService.getOrCreateBilling(org.id);
		if (billingService.hasActiveSubscription(billing)) {
			const portalUrl = await billingService.createPortalSession(
				billing.stripe_customer_id!,
				body.success_url,
			);
			return c.json({ url: portalUrl, redirected_to_portal: true });
		}

		const customerId = await billingService.ensureStripeCustomer(org.id, user.email, org.name);
		const checkoutUrl = await billingService.createCheckoutSession(
			org.id,
			customerId,
			body.price_id,
			body.success_url,
			body.cancel_url,
		);

		return c.json({ url: checkoutUrl });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create checkout session";
		console.error("Stripe checkout error:", error);
		return c.json({ error: "stripe_error", message }, 500);
	}
});

// POST /v1/billing/portal - Create Stripe billing portal session
api.post("/billing/portal", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{ return_url: string }>();

	if (!body.return_url) {
		return c.json({ error: "invalid_request", message: "return_url is required" }, 400);
	}

	if (!auth.orgId) {
		return c.json({ error: "unauthorized", message: "No organization found" }, 401);
	}

	const billingService = new BillingService(c.env);
	const billing = await billingService.getOrCreateBilling(auth.orgId);

	if (!billing.stripe_customer_id) {
		return c.json({ error: "not_found", message: "No billing account. Upgrade first." }, 404);
	}

	try {
		const portalUrl = await billingService.createPortalSession(
			billing.stripe_customer_id,
			body.return_url,
		);
		return c.json({ url: portalUrl });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create portal session";
		console.error("Stripe portal error:", error);
		return c.json({ error: "stripe_error", message }, 500);
	}
});

// POST /v1/billing/daimo/checkout - Create Daimo payment checkout
api.post("/billing/daimo/checkout", async (c) => {
	const auth = c.get("auth");
	const body = await c.req.json<{ success_url: string }>();

	if (!body.success_url) {
		return c.json({ error: "invalid_request", message: "success_url is required" }, 400);
	}

	if (!auth.orgId) {
		return c.json({ error: "unauthorized", message: "No organization found" }, 401);
	}

	const billingService = new BillingService(c.env);
	const daimoService = new DaimoBillingService(c.env);

	try {
		// Ensure billing record exists
		const billing = await billingService.getOrCreateBilling(auth.orgId);

		// Check for existing active Stripe subscription - redirect to portal
		if (billingService.hasActiveSubscription(billing)) {
			const portalUrl = await billingService.createPortalSession(
				billing.stripe_customer_id!,
				body.success_url,
			);
			return c.json({ url: portalUrl, redirected_to_portal: true });
		}

		// Check for existing active Daimo subscription - allow early renewal but inform user
		const hasActiveDaimo = daimoService.hasActiveDaimoSubscription(billing);

		const { url, paymentId } = await daimoService.createCheckout(auth.orgId, body.success_url);

		return c.json({
			url,
			payment_id: paymentId,
			is_renewal: hasActiveDaimo,
			current_period_end: hasActiveDaimo ? billing.current_period_end : null,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create Daimo checkout";
		console.error("Daimo checkout error:", error);
		return c.json({ error: "daimo_error", message }, 500);
	}
});

// POST /v1/referral/apply - Apply a referral code (rate limited)
api.post("/referral/apply", async (c) => {
	const { success } = await c.env.USERNAME_CHECK_LIMITER.limit({
		key: c.req.header("cf-connecting-ip") || "unknown",
	});
	if (!success) {
		return c.json({ error: "Rate limited" }, 429);
	}

	const auth = c.get("auth");
	const { code } = await c.req.json<{ code: string }>();

	if (!code || typeof code !== "string") {
		return c.json({ error: "Code required" }, 400);
	}

	const primaryOrg = await c.env.DB.prepare(
		"SELECT org_id FROM org_memberships WHERE user_id = ? ORDER BY created_at ASC LIMIT 1",
	)
		.bind(auth.userId)
		.first<{ org_id: string }>();

	if (!primaryOrg) {
		return c.json({ error: "No org found" }, 404);
	}

	const creditsService = new CreditsService(c.env);
	const result = await creditsService.recordReferralSignup(primaryOrg.org_id, code);
	return c.json(result);
});

api.post("/projects/:projectId/content-bucket", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has access to this project's org
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	try {
		// enableContentBucket is idempotent - repeated calls succeed
		const resource = await provisioning.enableContentBucket(projectId);
		return c.json({
			success: true,
			message: "Content bucket enabled",
			resource: { id: resource.id, resource_name: resource.resource_name },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to enable content bucket";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Create resource for existing project
api.post("/projects/:projectId/resources/:resourceType", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const resourceType = c.req.param("resourceType");

	// Validate resourceType
	if (resourceType !== "d1" && resourceType !== "kv" && resourceType !== "r2") {
		return c.json(
			{ error: "invalid_request", message: "resourceType must be one of: d1, kv, r2" },
			400,
		);
	}

	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse optional body for name/bindingName
	let options: { name?: string; bindingName?: string } = {};
	try {
		const body = await c.req.json<{ name?: string; binding_name?: string }>();
		options = {
			name: body.name,
			bindingName: body.binding_name,
		};
	} catch {
		// Empty body is OK, use defaults
	}

	try {
		const resource = await provisioning.createResourceForProject(projectId, resourceType, options);
		return c.json({ resource }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create resource";

		// Handle specific error cases
		if (message.includes("not yet implemented")) {
			return c.json({ error: "not_implemented", message }, 501);
		}

		return c.json({ error: "internal_error", message }, 500);
	}
});

// DELETE /v1/projects/:projectId/resources/:resourceId - Delete a project resource
api.delete("/projects/:projectId/resources/:resourceId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const resourceId = c.req.param("resourceId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get the resource
	const resource = await c.env.DB.prepare(
		"SELECT * FROM resources WHERE id = ? AND project_id = ? AND status != 'deleted'",
	)
		.bind(resourceId, projectId)
		.first<Resource>();

	if (!resource) {
		return c.json({ error: "not_found", message: "Resource not found" }, 404);
	}

	const cfClient = new CloudflareClient(c.env);
	let cloudflareDeleted = true;

	try {
		switch (resource.resource_type) {
			case "d1":
				await cfClient.deleteD1Database(resource.provider_id);
				break;
			case "kv":
				await cfClient.deleteKVNamespace(resource.provider_id);
				break;
			case "r2":
			case "r2_content":
				await cfClient.deleteR2Bucket(resource.resource_name);
				break;
			default:
				return c.json(
					{
						error: "invalid_request",
						message: `Cannot delete resource type: ${resource.resource_type}`,
					},
					400,
				);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to delete from Cloudflare";
		// Handle 404 - resource already gone from Cloudflare
		if (message.includes("could not be found") || message.includes("not found")) {
			cloudflareDeleted = false;
		} else {
			return c.json({ error: "internal_error", message }, 500);
		}
	}

	await c.env.DB.prepare("UPDATE resources SET status = 'deleted' WHERE id = ?")
		.bind(resourceId)
		.run();

	return c.json({
		success: true,
		resource_id: resourceId,
		deleted_at: new Date().toISOString(),
		cloudflare_deleted: cloudflareDeleted,
	});
});

api.patch("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Parse request body
	const body = await c.req.json<{ limits?: { requests_per_minute?: number } }>();

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Validate limits
	if (body.limits?.requests_per_minute !== undefined) {
		const rpm = body.limits.requests_per_minute;
		if (!Number.isInteger(rpm) || rpm < 1 || rpm > 100000) {
			return c.json(
				{
					error: "invalid_request",
					message: "requests_per_minute must be an integer between 1 and 100000",
				},
				400,
			);
		}
	}

	try {
		// Update project limits
		await provisioning.updateProjectLimits(projectId, body.limits);

		// Return updated project
		const updatedProject = await provisioning.getProject(projectId);
		return c.json({ project: updatedProject });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update project limits";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Tag validation regex: lowercase alphanumeric with colons and hyphens, must start/end with alphanumeric
const TAG_PATTERN = /^[a-z0-9][a-z0-9:-]*[a-z0-9]$|^[a-z0-9]$/;

api.put("/projects/:projectId/tags", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Parse request body
	const body = await c.req.json<{ tags: string[] }>();

	// Validate tags is an array
	if (!Array.isArray(body.tags)) {
		return c.json({ error: "invalid_request", message: "tags must be an array" }, 400);
	}

	// Validate max 20 tags
	if (body.tags.length > 20) {
		return c.json({ error: "invalid_request", message: "Maximum 20 tags allowed" }, 400);
	}

	// Validate each tag
	for (const tag of body.tags) {
		if (typeof tag !== "string") {
			return c.json({ error: "invalid_request", message: "Each tag must be a string" }, 400);
		}
		if (tag.length > 50) {
			return c.json(
				{
					error: "invalid_request",
					message: `Tag '${tag}' exceeds maximum length of 50 characters`,
				},
				400,
			);
		}
		if (!TAG_PATTERN.test(tag)) {
			return c.json(
				{
					error: "invalid_request",
					message: `Tag '${tag}' is invalid. Tags must be lowercase alphanumeric with colons and hyphens, starting and ending with alphanumeric characters`,
				},
				400,
			);
		}
	}

	// Get project and verify it exists
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Deduplicate and sort tags
	const uniqueTags = [...new Set(body.tags)].sort();
	const tagsJson = JSON.stringify(uniqueTags);

	try {
		await c.env.DB.prepare(
			"UPDATE projects SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
			.bind(tagsJson, projectId)
			.run();

		return c.json({ success: true, tags: uniqueTags });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update tags";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/tags", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify it exists
	const project = await c.env.DB.prepare(
		"SELECT id, org_id, tags FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; tags: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse tags from JSON, default to empty array
	let tags: string[] = [];
	try {
		tags = project.tags ? JSON.parse(project.tags) : [];
	} catch {
		// If parsing fails, return empty array
		tags = [];
	}

	return c.json({ tags });
});

// Database info endpoint (for managed projects - avoids wrangler dependency)
api.get("/projects/:projectId/database/info", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get D1 resource
	const d1Resource = await c.env.DB.prepare(
		"SELECT provider_id, resource_name FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ provider_id: string; resource_name: string }>();

	if (!d1Resource) {
		return c.json({ error: "not_found", message: "No database found for project" }, 404);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const dbInfo = await cfClient.getD1DatabaseInfo(d1Resource.provider_id);

		return c.json({
			name: dbInfo.name,
			id: dbInfo.uuid,
			sizeBytes: dbInfo.file_size || 0,
			numTables: dbInfo.num_tables || 0,
			version: dbInfo.version,
			createdAt: dbInfo.created_at,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to get database info";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Database execute endpoint (SQL execution)
api.post("/projects/:projectId/database/execute", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get D1 resource
	const d1Resource = await c.env.DB.prepare(
		"SELECT provider_id, resource_name FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ provider_id: string; resource_name: string }>();

	if (!d1Resource) {
		return c.json({ error: "not_found", message: "No database found for project" }, 404);
	}

	// Parse request body
	const body = await c.req.json<{ sql: string; params?: unknown[] }>();
	if (!body.sql || typeof body.sql !== "string") {
		return c.json(
			{ error: "invalid_request", message: "sql is required and must be a string" },
			400,
		);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const result = await cfClient.executeD1Query(d1Resource.provider_id, body.sql, body.params);

		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Query execution failed";
		return c.json({ error: "query_failed", message }, 500);
	}
});

// Database read-only query endpoint (for web UI)
api.post("/projects/:projectId/database/query", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const body = await c.req.json<{ sql: string; params?: unknown[]; binding_name?: string }>();
	if (!body.sql || typeof body.sql !== "string") {
		return c.json(
			{ error: "invalid_request", message: "sql is required and must be a string" },
			400,
		);
	}

	// Get D1 resource, filtering by binding_name if provided
	let d1Resource: { provider_id: string; resource_name: string } | null;
	if (body.binding_name) {
		d1Resource = await c.env.DB.prepare(
			"SELECT provider_id, resource_name FROM resources WHERE project_id = ? AND resource_type = 'd1' AND binding_name = ? AND status != 'deleted'",
		)
			.bind(projectId, body.binding_name)
			.first<{ provider_id: string; resource_name: string }>();
	} else {
		d1Resource = await c.env.DB.prepare(
			"SELECT provider_id, resource_name FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ provider_id: string; resource_name: string }>();
	}

	if (!d1Resource) {
		return c.json({ error: "not_found", message: "No database found for project" }, 404);
	}

	// Validate read-only
	const validationError = validateReadOnly(body.sql);
	if (validationError) {
		return c.json({ error: "read_only_violation", message: validationError }, 400);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const result = await cfClient.executeD1Query(d1Resource.provider_id, body.sql, body.params);

		return c.json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Query execution failed";
		return c.json({ error: "query_failed", message }, 500);
	}
});

// Database export endpoint
api.get("/projects/:projectId/database/export", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get D1 resource
	const d1Resource = await c.env.DB.prepare(
		"SELECT provider_id FROM resources WHERE project_id = ? AND resource_type = 'd1' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ provider_id: string }>();

	if (!d1Resource) {
		return c.json({ error: "not_found", message: "No database found for project" }, 404);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		const signedUrl = await cfClient.exportD1Database(d1Resource.provider_id, 60000);

		return c.json({
			success: true,
			download_url: signedUrl,
			expires_in: 3600,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Export failed";

		if (message.includes("timed out")) {
			return c.json(
				{
					error: "timeout",
					message: "Database export timed out. The database may be too large.",
				},
				504,
			);
		}

		return c.json({ error: "export_failed", message }, 500);
	}
});

// =====================================================
// Cron Schedule Endpoints
// =====================================================

const MAX_CRONS_PER_PROJECT = 5;
const MIN_CRON_INTERVAL_MINUTES = 15;

// Helper function to normalize cron expression
function normalizeCronExpression(expression: string): string {
	return expression.trim().replace(/\s+/g, " ");
}

// Helper function to validate cron expression and compute next run time
async function validateAndParseCron(
	expression: string,
): Promise<{ valid: boolean; error?: string; nextRun?: string; description?: string }> {
	try {
		// Dynamic import for cron-parser (ESM)
		const cronParser = await import("cron-parser");
		const cronstrue = await import("cronstrue");

		const normalized = normalizeCronExpression(expression);

		// Parse and validate
		const interval = cronParser.parseExpression(normalized);

		// Check minimum interval (15 minutes)
		const now = new Date();
		const first = interval.next().toDate();
		interval.reset();
		const second = interval.next().toDate();
		interval.reset();
		interval.next(); // skip first
		const secondRun = interval.next().toDate();

		const intervalMs = secondRun.getTime() - first.getTime();
		const intervalMinutes = intervalMs / (1000 * 60);

		if (intervalMinutes < MIN_CRON_INTERVAL_MINUTES) {
			return {
				valid: false,
				error: `Cron interval must be at least ${MIN_CRON_INTERVAL_MINUTES} minutes. This expression runs every ${Math.round(intervalMinutes)} minutes.`,
			};
		}

		// Get next run time
		interval.reset();
		const nextRun = interval.next().toDate().toISOString();

		// Get human-readable description
		let description: string;
		try {
			description = cronstrue.toString(normalized);
		} catch {
			description = normalized;
		}

		return { valid: true, nextRun, description };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Invalid cron expression";
		return { valid: false, error: message };
	}
}

// POST /v1/projects/:projectId/crons - Create a cron schedule
api.post("/projects/:projectId/crons", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string; cron_secret: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse request body
	const body = await c.req.json<{ expression: string }>();
	if (!body.expression || typeof body.expression !== "string") {
		return c.json(
			{ error: "invalid_request", message: "expression is required and must be a string" },
			400,
		);
	}

	// Validate cron expression
	const validation = await validateAndParseCron(body.expression);
	if (!validation.valid) {
		return c.json({ error: "invalid_cron", message: validation.error }, 400);
	}

	const normalized = normalizeCronExpression(body.expression);

	// Check existing cron count
	const countResult = await c.env.DB.prepare(
		"SELECT COUNT(*) as count FROM cron_schedules WHERE project_id = ?",
	)
		.bind(projectId)
		.first<{ count: number }>();

	if (countResult && countResult.count >= MAX_CRONS_PER_PROJECT) {
		return c.json(
			{
				error: "limit_exceeded",
				message: `Maximum ${MAX_CRONS_PER_PROJECT} cron schedules per project`,
			},
			400,
		);
	}

	// Check for duplicate expression
	const existing = await c.env.DB.prepare(
		"SELECT id FROM cron_schedules WHERE project_id = ? AND expression_normalized = ?",
	)
		.bind(projectId, normalized)
		.first<{ id: string }>();

	if (existing) {
		// Return existing schedule (idempotent)
		const schedule = await c.env.DB.prepare("SELECT * FROM cron_schedules WHERE id = ?")
			.bind(existing.id)
			.first();

		return c.json({
			id: existing.id,
			expression: body.expression,
			expression_normalized: normalized,
			description: validation.description,
			next_run_at: validation.nextRun,
			created: false,
			message: "Schedule already exists",
		});
	}

	// Generate cron_secret if not exists
	let cronSecret = project.cron_secret;
	if (!cronSecret) {
		cronSecret = crypto.randomUUID();
		await c.env.DB.prepare(
			"UPDATE projects SET cron_secret = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
			.bind(cronSecret, projectId)
			.run();
	}

	// Create cron schedule
	const cronId = `cron_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
	const now = new Date().toISOString();

	await c.env.DB.prepare(
		`INSERT INTO cron_schedules (id, project_id, expression, expression_normalized, next_run_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(cronId, projectId, body.expression, normalized, validation.nextRun, now)
		.run();

	return c.json(
		{
			id: cronId,
			expression: body.expression,
			expression_normalized: normalized,
			description: validation.description,
			next_run_at: validation.nextRun,
			created_at: now,
			created: true,
		},
		201,
	);
});

// GET /v1/projects/:projectId/deployments - List recent deployments
api.get("/projects/:projectId/deployments", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const deploymentService = new DeploymentService(c.env);
	const all = await deploymentService.listDeployments(projectId);
	const deployments = all.slice(0, 10).map((d) => ({
		id: d.id,
		status: d.status,
		source: d.source,
		error_message: d.error_message,
		message: d.message,
		created_at: d1DatetimeToIso(d.created_at),
		updated_at: d1DatetimeToIso(d.updated_at),
	}));

	return c.json({ deployments, total: all.length });
});

// GET /v1/projects/:projectId/deployments/latest - Get latest live deployment
api.get("/projects/:projectId/deployments/latest", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const deploymentService = new DeploymentService(c.env);
	const d = await deploymentService.getLatestDeployment(projectId);

	if (!d) {
		return c.json({ error: "not_found", message: "No deployment found" }, 404);
	}

	return c.json({
		deployment: {
			id: d.id,
			status: d.status,
			source: d.source,
			error_message: d.error_message,
			message: d.message,
			created_at: d1DatetimeToIso(d.created_at),
			updated_at: d1DatetimeToIso(d.updated_at),
		},
	});
});

// POST /v1/projects/:projectId/rollback - Roll back to a previous deployment
api.post("/projects/:projectId/rollback", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project (need org_id for auth check AND for resolveBindingsFromManifest)
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify org membership
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse optional deployment_id from body
	// Body may be empty for "rollback to previous"
	let deploymentId: string | undefined;
	try {
		const body = await c.req.json<{ deployment_id?: string }>();
		deploymentId = body.deployment_id;
	} catch {
		// Empty body is fine — means "rollback to previous"
	}

	try {
		const deploymentService = new DeploymentService(c.env);
		const deployment = await deploymentService.rollbackDeployment(projectId, deploymentId);
		return c.json({
			deployment: {
				id: deployment.id,
				status: deployment.status,
				source: deployment.source,
				created_at: d1DatetimeToIso(deployment.created_at),
				updated_at: d1DatetimeToIso(deployment.updated_at),
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Rollback failed";
		// Distinguish user errors from server errors
		if (
			message.includes("not found") ||
			message.includes("No previous") ||
			message.includes("Cannot roll back")
		) {
			return c.json({ error: "invalid_request", message }, 400);
		}
		return c.json({ error: "internal_error", message }, 500);
	}
});


// GET /v1/projects/:projectId/crons - List cron schedules
api.get("/projects/:projectId/crons", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get all cron schedules for project
	const schedules = await c.env.DB.prepare(
		`SELECT * FROM cron_schedules WHERE project_id = ? ORDER BY created_at DESC`,
	)
		.bind(projectId)
		.all<{
			id: string;
			expression: string;
			expression_normalized: string;
			enabled: number;
			is_running: number;
			last_run_at: string | null;
			next_run_at: string;
			last_run_status: string | null;
			last_run_duration_ms: number | null;
			consecutive_failures: number;
			created_at: string;
		}>();

	// Add human-readable descriptions
	const cronstrue = await import("cronstrue");
	const schedulesWithDescription = (schedules.results || []).map((s) => {
		let description: string;
		try {
			description = cronstrue.toString(s.expression_normalized);
		} catch {
			description = s.expression_normalized;
		}

		return {
			id: s.id,
			expression: s.expression,
			description,
			enabled: s.enabled === 1,
			is_running: s.is_running === 1,
			next_run_at: s.next_run_at,
			last_run_at: s.last_run_at,
			last_run_status: s.last_run_status,
			last_run_duration_ms: s.last_run_duration_ms,
			consecutive_failures: s.consecutive_failures,
			created_at: s.created_at,
		};
	});

	return c.json({ schedules: schedulesWithDescription });
});

// DELETE /v1/projects/:projectId/crons/:cronId - Delete a cron schedule
api.delete("/projects/:projectId/crons/:cronId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const cronId = c.req.param("cronId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check if cron exists
	const schedule = await c.env.DB.prepare(
		"SELECT id FROM cron_schedules WHERE id = ? AND project_id = ?",
	)
		.bind(cronId, projectId)
		.first<{ id: string }>();

	if (!schedule) {
		return c.json({ error: "not_found", message: "Cron schedule not found" }, 404);
	}

	// Delete the schedule
	await c.env.DB.prepare("DELETE FROM cron_schedules WHERE id = ?").bind(cronId).run();

	return c.json({
		success: true,
		deleted_id: cronId,
		deleted_at: new Date().toISOString(),
	});
});

// POST /v1/projects/:projectId/crons/trigger - Manually trigger a cron schedule
api.post("/projects/:projectId/crons/trigger", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		`SELECT p.*, r.resource_name as worker_name FROM projects p
     LEFT JOIN resources r ON r.project_id = p.id AND r.resource_type = 'worker' AND r.status != 'deleted'
     WHERE p.id = ? AND p.status != 'deleted'`,
	)
		.bind(projectId)
		.first<{
			id: string;
			org_id: string;
			cron_secret: string | null;
			worker_name: string | null;
		}>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	if (!project.worker_name) {
		return c.json({ error: "not_deployed", message: "Project has no deployed worker" }, 400);
	}

	// Parse request body
	const body = await c.req.json<{ expression: string }>();
	if (!body.expression || typeof body.expression !== "string") {
		return c.json(
			{ error: "invalid_request", message: "expression is required and must be a string" },
			400,
		);
	}

	const normalized = normalizeCronExpression(body.expression);

	// Check if schedule exists
	const schedule = await c.env.DB.prepare(
		"SELECT id FROM cron_schedules WHERE project_id = ? AND expression_normalized = ?",
	)
		.bind(projectId, normalized)
		.first<{ id: string }>();

	if (!schedule) {
		return c.json(
			{ error: "not_found", message: "Cron schedule not found. Create it first." },
			404,
		);
	}

	// Execute the cron
	const startTime = Date.now();
	let status = "success";
	let responseStatus: number | null = null;

	try {
		const worker = c.env.TENANT_DISPATCH.get(project.worker_name);

		// Build signed request (use empty secret if not set)
		const cronSecret = project.cron_secret || "";
		const timestamp = Date.now().toString();
		const payload = `${timestamp}.POST./__scheduled.${normalized}`;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(cronSecret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
		const signature = Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const response = await worker.fetch(
			new Request("https://internal/__scheduled", {
				method: "POST",
				headers: {
					"X-Jack-Cron": normalized,
					"X-Jack-Timestamp": timestamp,
					"X-Jack-Signature": signature,
				},
			}),
		);

		responseStatus = response.status;
		if (!response.ok) {
			status = `error:${response.status}`;
		}
	} catch (error) {
		status = "error:exception";
		console.error(`Manual cron trigger for ${projectId} failed:`, error);
	}

	const duration = Date.now() - startTime;

	return c.json({
		triggered: true,
		status,
		response_status: responseStatus,
		duration_ms: duration,
	});
});

// Project deletion endpoint
api.delete("/projects/:projectId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string; owner_username: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get all resources
	const resources = await c.env.DB.prepare(
		"SELECT * FROM resources WHERE project_id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.all<{
			resource_type: string;
			resource_name: string;
			provider_id: string;
			binding_name: string | null;
		}>();

	const cfClient = new CloudflareClient(c.env);
	const deletionResults: Array<{ resource: string; success: boolean; error?: string }> = [];

	// Delete dispatch worker
	const workerResource = resources.results?.find((r) => r.resource_type === "worker");
	if (workerResource) {
		try {
			await cfClient.deleteDispatchScript("jack-tenants", workerResource.resource_name);
			deletionResults.push({ resource: "worker", success: true });
		} catch (error) {
			deletionResults.push({ resource: "worker", success: false, error: String(error) });
		}
	}

	// Delete D1 database
	const d1Resource = resources.results?.find((r) => r.resource_type === "d1");
	if (d1Resource) {
		try {
			await cfClient.deleteD1Database(d1Resource.provider_id);
			deletionResults.push({ resource: "d1", success: true });
		} catch (error) {
			deletionResults.push({ resource: "d1", success: false, error: String(error) });
		}
	}

	// Delete R2 content bucket (legacy enableContentBucket flow)
	const r2ContentResource = resources.results?.find((r) => r.resource_type === "r2_content");
	if (r2ContentResource) {
		try {
			await cfClient.deleteR2Bucket(r2ContentResource.resource_name);
			deletionResults.push({ resource: "r2_content", success: true });
		} catch (error) {
			deletionResults.push({ resource: "r2_content", success: false, error: String(error) });
		}
	}

	// Delete user-defined R2 buckets (from wrangler.jsonc r2_buckets)
	const r2Resources = resources.results?.filter((r) => r.resource_type === "r2") ?? [];
	for (const r2Res of r2Resources) {
		try {
			await cfClient.deleteR2Bucket(r2Res.resource_name);
			deletionResults.push({ resource: `r2:${r2Res.resource_name}`, success: true });
		} catch (error) {
			deletionResults.push({
				resource: `r2:${r2Res.resource_name}`,
				success: false,
				error: String(error),
			});
		}
	}

	// Delete KV namespaces (from wrangler.jsonc kv_namespaces)
	const kvResources = resources.results?.filter((r) => r.resource_type === "kv") ?? [];
	for (const kvRes of kvResources) {
		try {
			await cfClient.deleteKVNamespace(kvRes.provider_id);
			deletionResults.push({
				resource: `kv:${kvRes.binding_name || kvRes.resource_name}`,
				success: true,
			});
		} catch (error) {
			deletionResults.push({
				resource: `kv:${kvRes.binding_name || kvRes.resource_name}`,
				success: false,
				error: String(error),
			});
		}
	}

	// Delete code bucket objects
	try {
		const prefix = `projects/${projectId}/`;
		const objects = await c.env.CODE_BUCKET.list({ prefix });
		for (const obj of objects.objects) {
			await c.env.CODE_BUCKET.delete(obj.key);
		}
		deletionResults.push({ resource: "code_bucket", success: true });
	} catch (error) {
		deletionResults.push({ resource: "code_bucket", success: false, error: String(error) });
	}

	// Unassign custom domains (delete from CF, clear cache, keep slot claimed)
	try {
		const customDomains = await c.env.DB.prepare(
			"SELECT id, hostname, cloudflare_id, status FROM custom_domains WHERE project_id = ?",
		)
			.bind(projectId)
			.all<{ id: string; hostname: string; cloudflare_id: string | null; status: string }>();

		const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);

		for (const domain of customDomains.results || []) {
			// Delete from Cloudflare if provisioned
			if (domain.cloudflare_id) {
				try {
					cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);
					await cfClient.deleteCustomHostname(domain.cloudflare_id);
				} catch (cfError) {
					const message = cfError instanceof Error ? cfError.message : String(cfError);
					// Treat "not found" as success (already deleted)
					if (!message.includes("not found") && !message.includes("does not exist")) {
						console.error(
							`Failed to delete custom hostname ${domain.hostname} from Cloudflare:`,
							cfError,
						);
					}
				}
			}

			// Clear KV cache
			await cacheService.deleteCustomDomainConfig(domain.hostname);

			// Unassign domain - keep as claimed slot
			await c.env.DB.prepare(
				"UPDATE custom_domains SET project_id = NULL, cloudflare_id = NULL, status = 'claimed', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
				.bind(domain.id)
				.run();
		}

		deletionResults.push({
			resource: "custom_domains",
			success: true,
			...(customDomains.results?.length ? { count: customDomains.results.length } : {}),
		});
	} catch (error) {
		deletionResults.push({ resource: "custom_domains", success: false, error: String(error) });
	}

	// Delete KV cache entries
	try {
		const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
		await cacheService.invalidateProject(
			projectId,
			project.slug,
			project.org_id,
			project.owner_username,
		);
		deletionResults.push({ resource: "kv_cache", success: true });
	} catch (error) {
		deletionResults.push({ resource: "kv_cache", success: false, error: String(error) });
	}

	// Clean up DO enforcement state (if any)
	await c.env.DB.prepare("DELETE FROM do_enforcement WHERE project_id = ?")
		.bind(projectId)
		.run();

	// Soft-delete in DB
	const now = new Date().toISOString();
	await c.env.DB.prepare(
		"UPDATE projects SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE id = ?",
	)
		.bind(now, now, projectId)
		.run();

	await c.env.DB.prepare("UPDATE resources SET status = 'deleted' WHERE project_id = ?")
		.bind(projectId)
		.run();

	const failures = deletionResults.filter((r) => !r.success);

	return c.json({
		success: true,
		project_id: projectId,
		deleted_at: now,
		resources: deletionResults,
		warnings:
			failures.length > 0
				? `Some resources could not be deleted: ${failures.map((f) => f.resource).join(", ")}`
				: undefined,
	});
});

// Deployment endpoints
api.post("/projects/:projectId/deployments", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Backfill owner_username if not set (for projects created before user set username)
	if (!project.owner_username) {
		const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
			.bind(auth.userId)
			.first<{ username: string | null }>();
		if (user?.username) {
			await c.env.DB.prepare(
				"UPDATE projects SET owner_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
				.bind(user.username, projectId)
				.run();
		}
	}

	// Parse and validate request body
	const body = await c.req.json<{ source: string }>();
	if (!body.source) {
		return c.json({ error: "invalid_request", message: "Source is required" }, 400);
	}

	// Validate source format (only template: supported for now)
	if (!body.source.startsWith("template:")) {
		return c.json(
			{ error: "invalid_request", message: "Only template: sources are supported" },
			400,
		);
	}

	try {
		const deploymentService = new DeploymentService(c.env);
		const deployment = await deploymentService.createDeployment(projectId, body.source);
		return c.json(deployment, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Deployment creation failed";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.post("/projects/:projectId/deployments/upload", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Backfill owner_username if not set (for projects created before user set username)
	if (!project.owner_username) {
		const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
			.bind(auth.userId)
			.first<{ username: string | null }>();
		if (user?.username) {
			await c.env.DB.prepare(
				"UPDATE projects SET owner_username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			)
				.bind(user.username, projectId)
				.run();
		}
	}

	// Parse multipart form data
	const formData = await c.req.formData();

	// Extract required parts
	const manifestFile = formData.get("manifest") as File | null;
	const bundleFile = formData.get("bundle") as File | null;
	const sourceFile = formData.get("source") as File | null;
	const schemaFile = formData.get("schema") as File | null;
	const secretsFile = formData.get("secrets") as File | null;
	const assetsFile = formData.get("assets") as File | null;
	const assetManifestFile = formData.get("asset-manifest") as File | null;
	const messageValue = formData.get("message");
	const deployMessage = typeof messageValue === "string" ? messageValue : null;

	// Validate required parts
	if (!manifestFile || !bundleFile) {
		return c.json({ error: "invalid_request", message: "manifest and bundle are required" }, 400);
	}

	try {
		// Parse manifest JSON
		const manifestText = await manifestFile.text();
		const manifest = JSON.parse(manifestText);

		// Validate manifest at API boundary (defense-in-depth)
		const manifestValidation = validateManifest(manifest);
		if (!manifestValidation.valid) {
			return c.json(
				{
					error: "invalid_manifest",
					message: "Manifest validation failed",
					details: manifestValidation.errors,
				},
				400,
			);
		}

		// Validate assets consistency at API boundary
		const hasAssetsFile = !!assetsFile;
		const hasAssetsBinding = !!manifest.bindings?.assets;

		if (hasAssetsBinding && !hasAssetsFile) {
			return c.json(
				{
					error: "missing_assets",
					message:
						"Assets binding declared in manifest but assets.zip is missing. " +
						"The deployment would fail at runtime when accessing env.ASSETS.",
				},
				400,
			);
		}

		if (hasAssetsFile && !hasAssetsBinding) {
			return c.json(
				{
					error: "orphan_assets",
					message:
						"assets.zip provided but no assets binding in manifest. " +
						"Add an assets section to wrangler.jsonc to enable static file serving.",
				},
				400,
			);
		}

		// Read file contents as ArrayBuffer
		const bundleData = await bundleFile.arrayBuffer();
		const sourceData = sourceFile ? await sourceFile.arrayBuffer() : null;
		const schemaText = schemaFile ? await schemaFile.text() : null;
		const secretsText = secretsFile ? await secretsFile.text() : null;
		let secretsJson: Record<string, string> | null = null;
		if (secretsText) {
			const parsed = JSON.parse(secretsText);
			if (isEncryptedEnvelope(parsed)) {
				if (!c.env.SECRETS_ENCRYPTION_PRIVATE_KEY) {
					return c.json(
						{
							error: "encryption_not_configured",
							message: "Server cannot decrypt secrets — encryption key not configured",
						},
						500,
					);
				}
				secretsJson = await decryptSecrets(
					parsed,
					JSON.parse(c.env.SECRETS_ENCRYPTION_PRIVATE_KEY),
				);
			} else {
				secretsJson = parsed;
			}
		}
		const assetsData = assetsFile ? await assetsFile.arrayBuffer() : null;
		const assetManifestText = assetManifestFile ? await assetManifestFile.text() : null;
		const assetManifest = assetManifestText ? JSON.parse(assetManifestText) : undefined;

		// Call DeploymentService.createCodeDeployment()
		const deploymentService = new DeploymentService(c.env);
		const deployment = await deploymentService.createCodeDeployment({
			projectId,
			manifest,
			bundleZip: bundleData,
			sourceZip: sourceData,
			schemaSql: schemaText,
			secretsJson,
			assetsZip: assetsData,
			assetManifest,
			message: deployMessage ?? undefined,
		});

		return c.json(deployment, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Deployment creation failed";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Secrets endpoints - never stores secrets in D1, passes directly to Cloudflare
api.post("/projects/:projectId/secrets", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse request body
	const body = await c.req.json<{ name: string; value: unknown }>();
	if (!body.name || !body.value) {
		return c.json({ error: "invalid_request", message: "name and value are required" }, 400);
	}

	// Validate secret name (alphanumeric and underscores only)
	if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.name)) {
		return c.json(
			{
				error: "invalid_request",
				message:
					"Secret name must start with a letter or underscore, and contain only letters, numbers, and underscores",
			},
			400,
		);
	}

	// Decrypt value if it's an encrypted envelope, otherwise use as-is (backward compat)
	let secretValue: string;
	if (isEncryptedEnvelope(body.value)) {
		if (!c.env.SECRETS_ENCRYPTION_PRIVATE_KEY) {
			return c.json(
				{
					error: "encryption_not_configured",
					message: "Server cannot decrypt secrets — encryption key not configured",
				},
				500,
			);
		}
		secretValue = await decryptSecretValue(
			body.value,
			JSON.parse(c.env.SECRETS_ENCRYPTION_PRIVATE_KEY),
		);
	} else if (typeof body.value === "string") {
		secretValue = body.value;
	} else {
		return c.json(
			{ error: "invalid_request", message: "value must be a string or encrypted envelope" },
			400,
		);
	}

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			return c.json({ error: "not_found", message: "Project has no deployed worker" }, 404);
		}

		const cfClient = new CloudflareClient(c.env);
		await cfClient.setDispatchScriptSecrets("jack-tenants", workerResource.resource_name, {
			[body.name]: secretValue,
		});

		return c.json({ success: true, name: body.name }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to set secret";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/secrets", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			// No worker deployed yet - return empty list
			return c.json({ secrets: [] });
		}

		const cfClient = new CloudflareClient(c.env);
		const secrets = await cfClient.listDispatchScriptSecrets(
			"jack-tenants",
			workerResource.resource_name,
		);

		// Only return names, not values (Cloudflare API already doesn't return values)
		return c.json({
			secrets: secrets.map((s) => ({ name: s.name })),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to list secrets";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.delete("/projects/:projectId/secrets/:secretName", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const secretName = c.req.param("secretName");
	const provisioning = new ProvisioningService(c.env);

	// Get project and verify it exists
	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Verify user has org membership access
	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	try {
		// Get worker resource name for this project
		const workerResource = await c.env.DB.prepare(
			"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
		)
			.bind(projectId)
			.first<{ resource_name: string }>();

		if (!workerResource) {
			return c.json({ error: "not_found", message: "Project has no deployed worker" }, 404);
		}

		const cfClient = new CloudflareClient(c.env);
		await cfClient.deleteDispatchScriptSecret(
			"jack-tenants",
			workerResource.resource_name,
			secretName,
		);

		return c.json({ success: true, name: secretName });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to delete secret";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Enable observability (Workers Logs) for a project
api.post("/projects/:projectId/observability", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const workerResource = await c.env.DB.prepare(
		"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ resource_name: string }>();

	if (!workerResource) {
		return c.json({ error: "not_found", message: "No worker deployed" }, 404);
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		await cfClient.enableScriptObservability("jack-tenants", workerResource.resource_name);

		return c.json({
			success: true,
			message: "Observability enabled. Logs will appear in the Cloudflare dashboard.",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to enable observability";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Real-time logs (Tail Workers) session management + streaming
// NOTE: Cloudflare Tail API is not available for dispatch namespace scripts. We use Tail Workers.
api.post("/projects/:projectId/logs/session", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();
	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const workerResource = await c.env.DB.prepare(
		"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ resource_name: string }>();
	if (!workerResource) {
		return c.json({ error: "no_worker_deployed", message: "No worker deployed" }, 409);
	}

	const body = await c.req.json<{ label?: string }>().catch(() => ({ label: undefined }));
	const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;

	let sessionId: string;
	try {
		const existing = await c.env.DB.prepare(
			"SELECT id FROM log_sessions WHERE project_id = ? AND status = 'active' LIMIT 1",
		)
			.bind(projectId)
			.first<{ id: string }>();
		const hadExisting = Boolean(existing?.id);

		if (existing?.id) {
			sessionId = existing.id;
			await c.env.DB.prepare(
				"UPDATE log_sessions SET expires_at = datetime('now', '+1 hour'), label = COALESCE(?, label) WHERE id = ?",
			)
				.bind(label, sessionId)
				.run();
		} else {
			sessionId = `logses_${crypto.randomUUID()}`;
			await c.env.DB.prepare(
				`INSERT INTO log_sessions (id, project_id, org_id, created_by, label, status, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now', '+1 hour'))`,
			)
				.bind(sessionId, projectId, project.org_id, auth.userId, label)
				.run();
		}

		const session = await c.env.DB.prepare(
			`SELECT id, project_id, label, status, expires_at
       FROM log_sessions
       WHERE id = ?`,
		)
			.bind(sessionId)
			.first<{
				id: string;
				project_id: string;
				label: string | null;
				status: string;
				expires_at: string;
			}>();

		if (!session) {
			throw new Error("Failed to load session");
		}

		// Attach Tail Worker only when starting a new session.
		// Renewals assume the Tail Worker is already attached for the active session.
		if (!hadExisting) {
			const cfClient = new CloudflareClient(c.env);
			try {
				await cfClient.setDispatchScriptTailConsumers(
					LOG_TAIL_DISPATCH_NAMESPACE,
					workerResource.resource_name,
					[{ service: LOG_TAIL_WORKER_SERVICE }],
				);
			} catch (error) {
				// Session exists but tail attach failed; mark revoked so user can retry immediately.
				await c.env.DB.prepare(
					"UPDATE log_sessions SET status = 'revoked', expires_at = CURRENT_TIMESTAMP WHERE id = ?",
				)
					.bind(session.id)
					.run();
				const message = error instanceof Error ? error.message : "Failed to attach Tail Worker";
				return c.json({ error: "internal_error", message }, 500);
			}
		}

		return c.json({
			success: true,
			session: {
				id: session.id,
				project_id: session.project_id,
				label: session.label,
				status: session.status,
				expires_at: d1DatetimeToIso(session.expires_at),
			},
			stream: { url: `/v1/projects/${projectId}/logs/stream`, type: "sse" },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create log session";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/logs/session", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();
	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const session = await c.env.DB.prepare(
		`SELECT id, project_id, label, status, expires_at
     FROM log_sessions
     WHERE project_id = ? AND status = 'active' AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
	)
		.bind(projectId)
		.first<{
			id: string;
			project_id: string;
			label: string | null;
			status: string;
			expires_at: string;
		}>();

	if (!session) {
		return c.json({ error: "no_active_session", message: "Start a 1h log session first." }, 410);
	}

	return c.json({
		success: true,
		session: {
			id: session.id,
			project_id: session.project_id,
			label: session.label,
			status: session.status,
			expires_at: d1DatetimeToIso(session.expires_at),
		},
	});
});

api.delete("/projects/:projectId/logs/session", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();
	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const workerResource = await c.env.DB.prepare(
		"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ resource_name: string }>();
	if (!workerResource) {
		return c.json({ error: "no_worker_deployed", message: "No worker deployed" }, 409);
	}

	const session = await c.env.DB.prepare(
		"SELECT id FROM log_sessions WHERE project_id = ? AND status = 'active' LIMIT 1",
	)
		.bind(projectId)
		.first<{ id: string }>();

	if (!session?.id) {
		return c.json({ error: "no_active_session", message: "No active session" }, 410);
	}

	const cfClient = new CloudflareClient(c.env);
	try {
		await cfClient.setDispatchScriptTailConsumers(
			LOG_TAIL_DISPATCH_NAMESPACE,
			workerResource.resource_name,
			[],
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to detach Tail Worker";
		return c.json({ error: "internal_error", message }, 500);
	}

	await c.env.DB.prepare(
		"UPDATE log_sessions SET status = 'revoked', expires_at = CURRENT_TIMESTAMP WHERE id = ?",
	)
		.bind(session.id)
		.run();

	return c.json({ success: true });
});

api.get("/projects/:projectId/logs/stream", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();
	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const session = await c.env.DB.prepare(
		`SELECT id, expires_at
     FROM log_sessions
     WHERE project_id = ? AND status = 'active' AND expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
	)
		.bind(projectId)
		.first<{ id: string; expires_at: string }>();

	if (!session) {
		return c.json({ error: "no_active_session", message: "Start a 1h log session first." }, 410);
	}

	const workerResource = await c.env.DB.prepare(
		"SELECT resource_name FROM resources WHERE project_id = ? AND resource_type = 'worker' AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ resource_name: string }>();
	if (!workerResource) {
		return c.json({ error: "no_worker_deployed", message: "No worker deployed" }, 409);
	}

	const id = c.env.LOG_STREAM.idFromName(workerResource.resource_name);
	const stub = c.env.LOG_STREAM.get(id);
	const url = new URL("http://do/stream");
	url.searchParams.set("session_id", session.id);
	url.searchParams.set("project_id", projectId);
	url.searchParams.set("expires_at", d1DatetimeToIso(session.expires_at));

	return stub.fetch(url.toString());
});

// =====================================================
// Custom Domain Endpoints
// =====================================================

// GET /v1/domains - List all domains across all projects for the user
api.get("/domains", async (c) => {
	const auth = c.get("auth");

	// Get all domains the user has access to via org membership (including unassigned domains)
	const result = await c.env.DB.prepare(
		`SELECT cd.*, p.slug as project_slug, p.owner_username
		 FROM custom_domains cd
		 JOIN org_memberships om ON cd.org_id = om.org_id
		 LEFT JOIN projects p ON cd.project_id = p.id AND p.status != 'deleted'
		 WHERE om.user_id = ? AND cd.status NOT IN ('deleting', 'deleted')
		 ORDER BY cd.created_at DESC`,
	)
		.bind(auth.userId)
		.all<CustomDomain & { project_slug: string | null; owner_username: string | null }>();

	// Get org billing info for slot calculation
	const orgsResult = await c.env.DB.prepare(
		`SELECT DISTINCT om.org_id, ob.plan_tier
		 FROM org_memberships om
		 LEFT JOIN org_billing ob ON om.org_id = ob.org_id
		 WHERE om.user_id = ?`,
	)
		.bind(auth.userId)
		.all<{ org_id: string; plan_tier: string | null }>();

	// Calculate slots used (all slot-consuming statuses count toward limit)
	const domains = result.results ?? [];
	const slotCount = domains.filter((d) =>
		SLOT_CONSUMING_STATUSES.includes(d.status as CustomDomainStatus),
	).length;

	// Determine max slots from highest plan tier across user's orgs + credits
	const orgs = orgsResult.results ?? [];
	const tiers = orgs.map((o) => o.plan_tier || "free");
	const hasPro = tiers.includes("pro") || tiers.includes("team");
	const tier = hasPro ? "pro" : "free";

	// Sum credits from primary org (first org)
	const primaryOrgId = orgs[0]?.org_id;
	let bonusDomains = 0;
	if (primaryOrgId) {
		const bonusResult = await c.env.DB.prepare(
			"SELECT COALESCE(SUM(amount), 0) as total FROM credits WHERE org_id = ? AND status = 'active'",
		)
			.bind(primaryOrgId)
			.first<{ total: number }>();
		bonusDomains = bonusResult?.total ?? 0;
	}

	const limits = computeLimits(tier as PlanTier, bonusDomains);
	const maxSlots = limits.custom_domains;

	const formattedDomains = domains.map((d) => ({
		...formatDomainResponse(d),
		project_id: d.project_id,
		project_slug: d.project_slug,
		project_url: d.project_slug
			? `https://${d.owner_username || "user"}-${d.project_slug}.runjack.xyz`
			: null,
	}));

	return c.json({
		domains: formattedDomains,
		slots: {
			used: slotCount,
			max: maxSlots,
		},
	});
});

// POST /v1/domains - Claim a domain slot (no project assignment, no Cloudflare call)
api.post("/domains", async (c) => {
	const auth = c.get("auth");

	// Parse and validate request
	const body = await c.req.json<{ hostname: string; org_id?: string }>();
	const hostnameError = validateHostname(body.hostname);
	if (hostnameError) {
		return c.json({ error: "invalid_hostname", message: hostnameError }, 400);
	}

	const hostname = body.hostname.toLowerCase().trim();

	// Get user's org (use provided org_id or default to first org)
	let orgId = body.org_id;
	if (!orgId) {
		const membership = await c.env.DB.prepare(
			"SELECT org_id FROM org_memberships WHERE user_id = ? LIMIT 1",
		)
			.bind(auth.userId)
			.first<{ org_id: string }>();

		if (!membership) {
			return c.json({ error: "no_org", message: "User has no organization" }, 400);
		}
		orgId = membership.org_id;
	} else {
		// Verify user is member of provided org
		const membership = await c.env.DB.prepare(
			"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
		)
			.bind(orgId, auth.userId)
			.first();

		if (!membership) {
			return c.json({ error: "not_found", message: "Organization not found" }, 404);
		}
	}

	// Count existing slot-consuming domains for this org
	const placeholders = SLOT_CONSUMING_STATUSES.map(() => "?").join(",");
	const domainCount = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM custom_domains
		 WHERE org_id = ? AND status IN (${placeholders})`,
	)
		.bind(orgId, ...SLOT_CONSUMING_STATUSES)
		.first<{ count: number }>();

	// Check gate
	const gate = await checkCustomDomainGate(c.env.DB, orgId, domainCount?.count || 0);
	if (!gate.allowed) {
		return c.json(gate.error, 403);
	}

	// Check if domain is already registered (globally unique, excluding deleted)
	const existingDomain = await c.env.DB.prepare(
		"SELECT id, org_id FROM custom_domains WHERE hostname = ? AND status != 'deleted'",
	)
		.bind(hostname)
		.first<{ id: string; org_id: string }>();

	if (existingDomain) {
		if (existingDomain.org_id === orgId) {
			return c.json(
				{ error: "domain_exists", message: "Domain already claimed by your organization" },
				409,
			);
		}
		return c.json(
			{ error: "domain_taken", message: "Domain is already registered to another organization" },
			409,
		);
	}

	// Create domain record in pending_dns state (requires DNS verification before assignment)
	const domainId = `dom_${crypto.randomUUID()}`;

	try {
		await c.env.DB.prepare(
			`INSERT INTO custom_domains (id, project_id, org_id, hostname, status)
       VALUES (?, NULL, ?, ?, 'pending_dns')`,
		)
			.bind(domainId, orgId, hostname)
			.run();

		const domain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
			.bind(domainId)
			.first<CustomDomain>();

		if (!domain) {
			throw new Error("Failed to retrieve created domain");
		}

		return c.json({ domain: formatDomainResponse(domain) }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to claim domain";

		if (message.includes("UNIQUE constraint") || message.includes("custom_domains.hostname")) {
			return c.json(
				{ error: "domain_taken", message: "Domain is already registered to another organization" },
				409,
			);
		}

		return c.json({ error: "internal_error", message }, 500);
	}
});

// POST /v1/domains/:domainId/assign - Assign a claimed domain to a project
api.post("/domains/:domainId/assign", async (c) => {
	const auth = c.get("auth");
	const domainId = c.req.param("domainId");

	// Parse request
	const body = await c.req.json<{ project_id: string }>();
	if (!body.project_id) {
		return c.json({ error: "invalid_request", message: "project_id is required" }, 400);
	}

	// Get domain and verify ownership via org membership
	const domain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
		.bind(domainId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(domain.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	// Check domain is in a state that can be assigned (claimed or unassigned)
	if (domain.status !== "claimed" && domain.status !== "unassigned") {
		const message =
			domain.status === "pending_dns"
				? "Domain DNS not verified. Run 'jack domain verify <hostname>' after adding CNAME record."
				: `Domain cannot be assigned from ${domain.status} state. Unassign it first if needed.`;
		return c.json({ error: "invalid_state", message }, 400);
	}

	// Get project and verify ownership (must be in same org)
	const project = await c.env.DB.prepare(
		"SELECT id, org_id, slug, owner_username FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(body.project_id)
		.first<{ id: string; org_id: string; slug: string; owner_username: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	if (project.org_id !== domain.org_id) {
		return c.json(
			{
				error: "invalid_request",
				message: "Domain and project must belong to the same organization",
			},
			400,
		);
	}

	// Check project doesn't already have a domain (v1: 1 domain per project)
	const existingProjectDomain = await c.env.DB.prepare(
		"SELECT id FROM custom_domains WHERE project_id = ? AND status NOT IN ('deleting', 'deleted')",
	)
		.bind(body.project_id)
		.first<{ id: string }>();

	if (existingProjectDomain) {
		return c.json(
			{
				error: "project_limit_reached",
				message: "This project already has a custom domain. Remove it first to add a new one.",
			},
			409,
		);
	}

	const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);

	// Quick reassign: if domain has existing CF hostname, verify it's still active
	if (domain.cloudflare_id && domain.status === "unassigned") {
		try {
			const cfClient = new CloudflareClient(c.env);
			cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);
			const cfHostname = await cfClient.getCustomHostname(domain.cloudflare_id);
			const jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

			if (jackStatus === "active") {
				// Instant activation - just update project association
				await c.env.DB.prepare(
					`UPDATE custom_domains
           SET project_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(body.project_id, domainId)
					.run();

				// Restore KV cache for routing
				const projectConfig = await cacheService.getProjectConfig(project.id);
				if (projectConfig && projectConfig.status === "active") {
					await cacheService.setCustomDomainConfig(domain.hostname, projectConfig);
				}

				const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
					.bind(domainId)
					.first<CustomDomain>();

				return c.json({ domain: formatDomainResponse(updatedDomain!) });
			}
			// If not active (SSL pending/degraded), fall through to create new hostname
		} catch (error) {
			// CF hostname was deleted externally - fall through to create new
			console.log(`Cloudflare hostname ${domain.cloudflare_id} not found, creating new`);
		}
	}

	try {
		// Call Cloudflare API to create custom hostname
		const cfClient = new CloudflareClient(c.env);
		cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);

		const cfHostname = await cfClient.createCustomHostname(domain.hostname);

		// Map Cloudflare status to Jack status
		const jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

		// Update domain with project assignment and Cloudflare response
		await c.env.DB.prepare(
			`UPDATE custom_domains
       SET project_id = ?,
           cloudflare_id = ?,
           status = ?,
           ssl_status = ?,
           ownership_verification_type = ?,
           ownership_verification_name = ?,
           ownership_verification_value = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
		)
			.bind(
				body.project_id,
				cfHostname.id,
				jackStatus,
				cfHostname.ssl?.status ?? null,
				cfHostname.ownership_verification?.type ?? null,
				cfHostname.ownership_verification?.name ?? null,
				cfHostname.ownership_verification?.value ?? null,
				domainId,
			)
			.run();

		// If domain is immediately active, write to cache
		if (jackStatus === "active") {
			const projectConfig = await cacheService.getProjectConfig(project.id);
			if (projectConfig && projectConfig.status === "active") {
				await cacheService.setCustomDomainConfig(domain.hostname, projectConfig);
			}
		}

		// Fetch the updated domain
		const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
			.bind(domainId)
			.first<CustomDomain>();

		if (!updatedDomain) {
			throw new Error("Failed to retrieve updated domain");
		}

		return c.json({ domain: formatDomainResponse(updatedDomain) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to assign domain";

		// Handle specific Cloudflare errors
		if (message.includes("blocked") || message.includes("high risk")) {
			return c.json(
				{
					error: "domain_blocked",
					message: "This hostname has been blocked by Cloudflare. Contact support.",
				},
				422,
			);
		}

		return c.json({ error: "internal_error", message }, 500);
	}
});

// POST /v1/domains/:domainId/unassign - Unassign domain from project (keep in org)
api.post("/domains/:domainId/unassign", async (c) => {
	const auth = c.get("auth");
	const domainId = c.req.param("domainId");

	// Get domain and verify ownership via org membership
	const domain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
		.bind(domainId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(domain.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	// Already unassigned
	if ((domain.status === "claimed" || domain.status === "unassigned") && !domain.project_id) {
		return c.json({ domain: formatDomainResponse(domain) });
	}

	// Cannot unassign domains that are deleting
	if (domain.status === "deleting") {
		return c.json(
			{ error: "invalid_state", message: "Cannot unassign a domain that is being deleted" },
			400,
		);
	}

	// DON'T delete from Cloudflare - keep hostname for quick reassignment

	// Delete KV cache entry to stop routing traffic
	const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
	await cacheService.deleteCustomDomainConfig(domain.hostname);

	// Set to unassigned if CF hostname exists (for quick reassign), otherwise claimed
	// Keep cloudflare_id, ssl_status, dns_* fields for instant reactivation
	await c.env.DB.prepare(
		`UPDATE custom_domains
     SET project_id = NULL,
         status = CASE WHEN cloudflare_id IS NOT NULL THEN 'unassigned' ELSE 'claimed' END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(domainId)
		.run();

	// Fetch updated domain
	const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
		.bind(domainId)
		.first<CustomDomain>();

	if (!updatedDomain) {
		return c.json({ error: "internal_error", message: "Failed to retrieve updated domain" }, 500);
	}

	return c.json({ domain: formatDomainResponse(updatedDomain) });
});

// POST /v1/domains/:domainId/verify - Manually trigger DNS verification (rate limited)
api.post("/domains/:domainId/verify", async (c) => {
	// Rate limit to prevent DNS query abuse
	const { success } = await c.env.USERNAME_CHECK_LIMITER.limit({
		key: c.req.header("cf-connecting-ip") || "unknown",
	});
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many requests. Try again in a minute." },
			429,
		);
	}

	const auth = c.get("auth");
	const domainId = c.req.param("domainId");

	// Get domain and verify ownership via org membership
	const domain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
		.bind(domainId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(domain.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	// Only verify domains in pending_dns status
	if (domain.status !== "pending_dns") {
		return c.json(
			{
				error: "invalid_state",
				message:
					domain.status === "claimed"
						? "Domain already verified. Assign to a project with 'jack domain assign <hostname> <project>'."
						: `Cannot verify domain in ${domain.status} state`,
			},
			400,
		);
	}

	// Perform DNS verification
	const dnsResult = await verifyDns(domain.hostname);
	const now = new Date().toISOString().replace("T", " ").replace("Z", "");

	if (dnsResult.verified) {
		// DNS verified - transition to 'claimed' status
		await c.env.DB.prepare(
			`UPDATE custom_domains
       SET status = 'claimed',
           dns_verified = 1,
           dns_verified_at = ?,
           dns_last_checked_at = ?,
           dns_target = ?,
           dns_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
		)
			.bind(now, now, dnsResult.target, domainId)
			.run();
	} else {
		// DNS not verified - update check timestamp and error
		await c.env.DB.prepare(
			`UPDATE custom_domains
       SET dns_last_checked_at = ?,
           dns_target = ?,
           dns_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
		)
			.bind(now, dnsResult.target, dnsResult.error, domainId)
			.run();
	}

	// Fetch and return updated domain
	const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
		.bind(domainId)
		.first<CustomDomain>();

	if (!updatedDomain) {
		return c.json({ error: "internal_error", message: "Failed to retrieve updated domain" }, 500);
	}

	return c.json({
		domain: formatDomainResponse(updatedDomain),
		dns_verified: dnsResult.verified,
	});
});

// DELETE /v1/domains/:domainId - Soft delete domain (release slot)
api.delete("/domains/:domainId", async (c) => {
	const auth = c.get("auth");
	const domainId = c.req.param("domainId");

	// Get domain and verify ownership via org membership
	const domain = await c.env.DB.prepare(
		"SELECT * FROM custom_domains WHERE id = ? AND status != 'deleted'",
	)
		.bind(domainId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(domain.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	// Mark as deleting while we clean up Cloudflare
	await c.env.DB.prepare(
		"UPDATE custom_domains SET status = 'deleting', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
	)
		.bind(domainId)
		.run();

	let cloudflareDeleted = true;

	// Delete from Cloudflare if we have a cloudflare_id
	if (domain.cloudflare_id) {
		try {
			const cfClient = new CloudflareClient(c.env);
			cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);
			await cfClient.deleteCustomHostname(domain.cloudflare_id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Treat "not found" as success (already deleted)
			if (!message.includes("not found") && !message.includes("does not exist")) {
				cloudflareDeleted = false;
				console.error("Failed to delete custom hostname from Cloudflare:", error);
			}
		}
	}

	// Delete KV cache entry for custom domain routing
	const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
	await cacheService.deleteCustomDomainConfig(domain.hostname);

	// Soft delete - set status to 'deleted' instead of removing the row
	await c.env.DB.prepare(
		`UPDATE custom_domains
     SET status = 'deleted',
         project_id = NULL,
         cloudflare_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(domainId)
		.run();

	return c.json({
		success: true,
		hostname: domain.hostname,
		cloudflare_deleted: cloudflareDeleted,
	});
});

// POST /v1/projects/:projectId/domains - Add custom domain
api.post("/projects/:projectId/domains", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT id, org_id, slug, owner_username FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string; slug: string; owner_username: string | null }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Parse and validate request
	const body = await c.req.json<{ hostname: string }>();
	const hostnameError = validateHostname(body.hostname);
	if (hostnameError) {
		return c.json({ error: "invalid_hostname", message: hostnameError }, 400);
	}

	const hostname = body.hostname.toLowerCase().trim();

	// Check plan entitlements - count existing slot-consuming domains for this org
	const placeholders = SLOT_CONSUMING_STATUSES.map(() => "?").join(",");
	const domainCount = await c.env.DB.prepare(
		`SELECT COUNT(*) as count FROM custom_domains
		 WHERE org_id = ? AND status IN (${placeholders})`,
	)
		.bind(project.org_id, ...SLOT_CONSUMING_STATUSES)
		.first<{ count: number }>();

	// Check gate
	const gate = await checkCustomDomainGate(c.env.DB, project.org_id, domainCount?.count || 0);
	if (!gate.allowed) {
		return c.json(gate.error, 403);
	}

	// Check if domain is already registered (globally unique, excluding deleted)
	const existingDomain = await c.env.DB.prepare(
		"SELECT id, project_id FROM custom_domains WHERE hostname = ? AND status != 'deleted'",
	)
		.bind(hostname)
		.first<{ id: string; project_id: string | null }>();

	if (existingDomain) {
		if (existingDomain.project_id === projectId) {
			return c.json(
				{ error: "domain_exists", message: "Domain already added to this project" },
				409,
			);
		}
		return c.json({ error: "domain_taken", message: "Domain is already registered" }, 409);
	}

	// Check project doesn't already have a domain (v1: 1 domain per project)
	const existingProjectDomain = await c.env.DB.prepare(
		"SELECT id FROM custom_domains WHERE project_id = ? AND status NOT IN ('deleting', 'deleted')",
	)
		.bind(projectId)
		.first<{ id: string }>();

	if (existingProjectDomain) {
		return c.json(
			{
				error: "project_limit_reached",
				message: "This project already has a custom domain. Remove it first to add a new one.",
			},
			409,
		);
	}

	// Create domain record in pending state
	const domainId = `dom_${crypto.randomUUID()}`;

	try {
		// Insert domain record
		await c.env.DB.prepare(
			`INSERT INTO custom_domains (id, project_id, org_id, hostname, status)
       VALUES (?, ?, ?, ?, 'pending')`,
		)
			.bind(domainId, projectId, project.org_id, hostname)
			.run();

		// Call Cloudflare API to create custom hostname
		const cfClient = new CloudflareClient(c.env);
		cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);

		const cfHostname = await cfClient.createCustomHostname(hostname);

		// Map Cloudflare status to Jack status
		const jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

		// Update domain with Cloudflare response
		await c.env.DB.prepare(
			`UPDATE custom_domains
       SET cloudflare_id = ?,
           status = ?,
           ssl_status = ?,
           ownership_verification_type = ?,
           ownership_verification_name = ?,
           ownership_verification_value = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
		)
			.bind(
				cfHostname.id,
				jackStatus,
				cfHostname.ssl?.status ?? null,
				cfHostname.ownership_verification?.type ?? null,
				cfHostname.ownership_verification?.name ?? null,
				cfHostname.ownership_verification?.value ?? null,
				domainId,
			)
			.run();

		// If domain is immediately active, write to cache
		if (jackStatus === "active") {
			const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
			const projectConfig = await cacheService.getProjectConfig(project.id);
			if (projectConfig && projectConfig.status === "active") {
				await cacheService.setCustomDomainConfig(hostname, projectConfig);
			}
		}

		// Fetch the created domain
		const domain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
			.bind(domainId)
			.first<CustomDomain>();

		if (!domain) {
			throw new Error("Failed to retrieve created domain");
		}

		return c.json({ domain: formatDomainResponse(domain) }, 201);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to add domain";

		// Clean up DB record if Cloudflare API failed
		await c.env.DB.prepare("DELETE FROM custom_domains WHERE id = ?").bind(domainId).run();

		// Handle UNIQUE constraint violation (race condition where another request inserted first)
		if (message.includes("UNIQUE constraint") || message.includes("custom_domains.hostname")) {
			return c.json(
				{ error: "domain_taken", message: "Domain is already registered to another project" },
				409,
			);
		}

		// Handle specific Cloudflare errors
		if (message.includes("blocked") || message.includes("high risk")) {
			return c.json(
				{
					error: "domain_blocked",
					message: "This hostname has been blocked by Cloudflare. Contact support.",
				},
				422,
			);
		}

		return c.json({ error: "internal_error", message }, 500);
	}
});

// GET /v1/projects/:projectId/domains - List domains for project
api.get("/projects/:projectId/domains", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT id, org_id FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// List all domains for project (excluding deleting)
	const result = await c.env.DB.prepare(
		"SELECT * FROM custom_domains WHERE project_id = ? AND status NOT IN ('deleting', 'deleted') ORDER BY created_at DESC",
	)
		.bind(projectId)
		.all<CustomDomain>();

	const domains = (result.results ?? []).map(formatDomainResponse);

	return c.json({ domains });
});

// GET /v1/projects/:projectId/domains/:domainId - Get domain details
api.get("/projects/:projectId/domains/:domainId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const domainId = c.req.param("domainId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT id, org_id FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get domain
	const domain = await c.env.DB.prepare(
		"SELECT * FROM custom_domains WHERE id = ? AND project_id = ?",
	)
		.bind(domainId, projectId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	return c.json({ domain: formatDomainResponse(domain) });
});

// DELETE /v1/projects/:projectId/domains/:domainId - Soft delete domain
api.delete("/projects/:projectId/domains/:domainId", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const domainId = c.req.param("domainId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT id, org_id FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get domain (excluding already deleted)
	const domain = await c.env.DB.prepare(
		"SELECT * FROM custom_domains WHERE id = ? AND project_id = ? AND status != 'deleted'",
	)
		.bind(domainId, projectId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	// Mark as deleting while we clean up Cloudflare
	await c.env.DB.prepare(
		"UPDATE custom_domains SET status = 'deleting', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
	)
		.bind(domainId)
		.run();

	let cloudflareDeleted = true;

	// Delete from Cloudflare if we have a cloudflare_id
	if (domain.cloudflare_id) {
		try {
			const cfClient = new CloudflareClient(c.env);
			cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);
			await cfClient.deleteCustomHostname(domain.cloudflare_id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Treat "not found" as success (already deleted)
			if (!message.includes("not found") && !message.includes("does not exist")) {
				cloudflareDeleted = false;
				console.error("Failed to delete custom hostname from Cloudflare:", error);
			}
		}
	}

	// Delete KV cache entry for custom domain routing
	const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
	await cacheService.deleteCustomDomainConfig(domain.hostname);

	// Soft delete - set status to 'deleted' instead of removing the row
	await c.env.DB.prepare(
		`UPDATE custom_domains
     SET status = 'deleted',
         project_id = NULL,
         cloudflare_id = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(domainId)
		.run();

	return c.json({
		success: true,
		hostname: domain.hostname,
		cloudflare_deleted: cloudflareDeleted,
	});
});

// POST /v1/projects/:projectId/domains/:domainId/verify - Manually trigger verification (rate limited)
api.post("/projects/:projectId/domains/:domainId/verify", async (c) => {
	// Rate limit to prevent DNS query abuse
	const { success } = await c.env.USERNAME_CHECK_LIMITER.limit({
		key: c.req.header("cf-connecting-ip") || "unknown",
	});
	if (!success) {
		return c.json(
			{ error: "rate_limited", message: "Too many requests. Try again in a minute." },
			429,
		);
	}

	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const domainId = c.req.param("domainId");

	// Get project and verify ownership
	const project = await c.env.DB.prepare(
		"SELECT id, org_id FROM projects WHERE id = ? AND status != 'deleted'",
	)
		.bind(projectId)
		.first<{ id: string; org_id: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Get domain
	const domain = await c.env.DB.prepare(
		"SELECT * FROM custom_domains WHERE id = ? AND project_id = ?",
	)
		.bind(domainId, projectId)
		.first<CustomDomain>();

	if (!domain) {
		return c.json({ error: "not_found", message: "Domain not found" }, 404);
	}

	if (!domain.cloudflare_id) {
		return c.json(
			{ error: "invalid_state", message: "Domain not yet submitted to Cloudflare" },
			400,
		);
	}

	// Already active
	if (domain.status === "active") {
		return c.json({ domain: formatDomainResponse(domain) });
	}

	try {
		const cfClient = new CloudflareClient(c.env);
		cfClient.setZoneId(c.env.CLOUDFLARE_ZONE_ID);

		// Refresh the hostname to trigger re-validation
		const cfHostname = await cfClient.refreshCustomHostname(domain.cloudflare_id);

		// Map Cloudflare status to Jack status
		const jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

		// Collect validation errors
		const validationErrors: string[] = [];
		if (cfHostname.ssl?.validation_errors) {
			validationErrors.push(...cfHostname.ssl.validation_errors.map((e) => e.message));
		}
		if (cfHostname.verification_errors) {
			validationErrors.push(...cfHostname.verification_errors);
		}

		// Update domain status
		await c.env.DB.prepare(
			`UPDATE custom_domains
       SET status = ?,
           ssl_status = ?,
           validation_errors = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
		)
			.bind(
				jackStatus,
				cfHostname.ssl?.status ?? null,
				validationErrors.length > 0 ? JSON.stringify(validationErrors) : null,
				domainId,
			)
			.run();

		// If now active, write to KV cache for dispatch worker routing
		if (jackStatus === "active") {
			const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
			const projectConfig = await cacheService.getProjectConfig(project.id);

			if (projectConfig && projectConfig.status === "active") {
				await cacheService.setCustomDomainConfig(domain.hostname, projectConfig);
			}
		}

		// Fetch updated domain
		const updatedDomain = await c.env.DB.prepare("SELECT * FROM custom_domains WHERE id = ?")
			.bind(domainId)
			.first<CustomDomain>();

		if (!updatedDomain) {
			throw new Error("Failed to retrieve updated domain");
		}

		return c.json({ domain: formatDomainResponse(updatedDomain) });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Verification failed";
		return c.json({ error: "verification_failed", message }, 500);
	}
});

// Source code retrieval endpoints
api.get("/projects/:projectId/source/tree", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const deploymentService = new DeploymentService(c.env);
	const deployment = await deploymentService.getLatestDeployment(projectId);

	if (!deployment) {
		return c.json({ error: "not_found", message: "No deployment found" }, 404);
	}

	if (!deployment.artifact_bucket_key) {
		return c.json({ error: "not_found", message: "No source code available" }, 404);
	}

	// Check KV cache first
	const cacheKey = `source-tree:${deployment.id}`;
	const cached = await c.env.PROJECTS_CACHE.get(cacheKey);
	if (cached) {
		return c.json(JSON.parse(cached));
	}

	// Fetch source.zip from R2
	const sourceKey = `${deployment.artifact_bucket_key}/source.zip`;
	const sourceObj = await c.env.CODE_BUCKET.get(sourceKey);

	if (!sourceObj) {
		return c.json({ error: "not_found", message: "Source code not found in storage" }, 404);
	}

	try {
		const zipData = await sourceObj.arrayBuffer();
		const files = unzipSync(new Uint8Array(zipData));

		// Build file tree
		const tree: Array<{ path: string; size: number; type: "file" | "directory" }> = [];
		const directories = new Set<string>();

		for (const [path, content] of Object.entries(files)) {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) {
				directories.add(parts.slice(0, i).join("/"));
			}
			tree.push({ path, size: content.length, type: "file" });
		}

		for (const dir of directories) {
			tree.push({ path: dir, size: 0, type: "directory" });
		}

		tree.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.path.localeCompare(b.path);
		});

		const response = {
			deployment_id: deployment.id,
			files: tree,
			total_files: tree.filter((f) => f.type === "file").length,
		};

		// Cache for 1 hour
		await c.env.PROJECTS_CACHE.put(cacheKey, JSON.stringify(response), { expirationTtl: 3600 });

		return c.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to read source";
		return c.json({ error: "internal_error", message }, 500);
	}
});

api.get("/projects/:projectId/source/file", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");
	const filePath = c.req.query("path");

	if (!filePath) {
		return c.json({ error: "invalid_request", message: "path query parameter is required" }, 400);
	}

	// Path traversal protection
	if (filePath.includes("..") || filePath.includes("//")) {
		return c.json({ error: "invalid_request", message: "Invalid path" }, 400);
	}

	const provisioning = new ProvisioningService(c.env);

	const project = await provisioning.getProject(projectId);
	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const membership = await c.env.DB.prepare(
		"SELECT 1 FROM org_memberships WHERE org_id = ? AND user_id = ?",
	)
		.bind(project.org_id, auth.userId)
		.first();

	if (!membership) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	const deploymentService = new DeploymentService(c.env);
	const deployment = await deploymentService.getLatestDeployment(projectId);

	if (!deployment) {
		return c.json({ error: "not_found", message: "No deployment found" }, 404);
	}

	if (!deployment.artifact_bucket_key) {
		return c.json({ error: "not_found", message: "No source code available" }, 404);
	}

	const sourceKey = `${deployment.artifact_bucket_key}/source.zip`;
	const sourceObj = await c.env.CODE_BUCKET.get(sourceKey);

	if (!sourceObj) {
		return c.json({ error: "not_found", message: "Source code not found in storage" }, 404);
	}

	try {
		const zipData = await sourceObj.arrayBuffer();
		const files = unzipSync(new Uint8Array(zipData));

		// Normalize path
		const normalizedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

		const fileContent = files[normalizedPath];
		if (!fileContent) {
			return c.json({ error: "not_found", message: `File not found: ${filePath}` }, 404);
		}

		const contentType = getMimeType(normalizedPath);
		const isText =
			contentType.startsWith("text/") ||
			contentType === "application/json" ||
			contentType === "application/javascript" ||
			contentType === "application/xml";

		if (isText) {
			const text = new TextDecoder().decode(fileContent);
			return new Response(text, {
				headers: {
					"Content-Type": `${contentType}; charset=utf-8`,
					"X-Deployment-Id": deployment.id,
				},
			});
		}

		return new Response(fileContent, {
			headers: {
				"Content-Type": contentType,
				"X-Deployment-Id": deployment.id,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to read source";
		return c.json({ error: "internal_error", message }, 500);
	}
});

// Shared handler for serving project source from deployment artifacts
async function serveProjectSource(
	env: Bindings,
	project: { id: string; slug: string },
): Promise<Response> {
	const deploymentService = new DeploymentService(env);
	const deployment = await deploymentService.getLatestDeployment(project.id);

	if (!deployment?.artifact_bucket_key) {
		return Response.json(
			{ error: "not_found", message: "No source available. Deploy first with 'jack ship'." },
			{ status: 404 },
		);
	}

	const sourceObj = await env.CODE_BUCKET.get(`${deployment.artifact_bucket_key}/source.zip`);
	if (!sourceObj) {
		return Response.json(
			{ error: "not_found", message: "No source available. Deploy first with 'jack ship'." },
			{ status: 404 },
		);
	}

	return new Response(sourceObj.body, {
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${project.slug}-source.zip"`,
		},
	});
}

// Download own project's source (authenticated)
api.get("/me/projects/:slug/source", async (c) => {
	const auth = c.get("auth");
	const slug = c.req.param("slug");

	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE org_id = ? AND slug = ? AND status != 'deleted'",
	)
		.bind(auth.orgId, slug)
		.first<{ id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	return serveProjectSource(c.env, project);
});

// Publish project for forking
api.post("/projects/:projectId/publish", async (c) => {
	const auth = c.get("auth");
	const projectId = c.req.param("projectId");

	// Verify ownership
	const project = await c.env.DB.prepare(
		"SELECT * FROM projects WHERE id = ? AND org_id = ? AND status != 'deleted'",
	)
		.bind(projectId, auth.orgId)
		.first<{ slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Project not found" }, 404);
	}

	// Check user has username set
	const user = await c.env.DB.prepare("SELECT username FROM users WHERE id = ?")
		.bind(auth.userId)
		.first<{ username: string | null }>();

	if (!user?.username) {
		return c.json(
			{
				error: "username_required",
				message: "Set your username first during login",
			},
			400,
		);
	}

	// Check project has source available via deployment artifacts
	const deploymentService = new DeploymentService(c.env);
	const latestDeploy = await deploymentService.getLatestDeployment(projectId);

	if (!latestDeploy?.artifact_bucket_key) {
		return c.json(
			{
				error: "no_source",
				message: "Deploy your project first with jack ship",
			},
			400,
		);
	}

	const sourceObj = await c.env.CODE_BUCKET.get(`${latestDeploy.artifact_bucket_key}/source.zip`);
	if (!sourceObj) {
		return c.json(
			{
				error: "no_source",
				message: "Deploy your project first with jack ship",
			},
			400,
		);
	}

	// Update visibility and owner_username in DB
	await c.env.DB.prepare(
		`UPDATE projects
     SET visibility = 'public', owner_username = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
	)
		.bind(user.username, projectId)
		.run();

	// Update KV cache with new key format for dispatch worker routing
	// Fetch full project config to cache
	const fullProject = await c.env.DB.prepare(
		`SELECT p.*, r.provider_id as d1_database_id
		 FROM projects p
		 LEFT JOIN resources r ON r.project_id = p.id AND r.resource_type = 'd1' AND r.status != 'deleted'
		 WHERE p.id = ?`,
	)
		.bind(projectId)
		.first<{
			id: string;
			org_id: string;
			slug: string;
			content_bucket_enabled: number | null;
			status: string;
			updated_at: string;
			d1_database_id: string | null;
		}>();

	if (fullProject) {
		// Derive worker name from project ID (same logic as provisioning)
		const shortId = fullProject.id.replace("proj_", "").slice(0, 16);
		const workerName = `jack-${shortId}`;
		const contentBucketName = fullProject.content_bucket_enabled ? `jack-${shortId}-content` : null;

		// Get tier from org_billing
		const billing = await c.env.DB.prepare("SELECT plan_tier FROM org_billing WHERE org_id = ?")
			.bind(fullProject.org_id)
			.first<{ plan_tier: string }>();

		const projectConfig: ProjectConfig = {
			project_id: fullProject.id,
			org_id: fullProject.org_id,
			owner_username: user.username,
			slug: fullProject.slug,
			worker_name: workerName,
			d1_database_id: fullProject.d1_database_id || "",
			content_bucket_name: contentBucketName,
			status: fullProject.status as ProjectStatus,
			tier: (billing?.plan_tier as "free" | "pro" | "team") || "free",
			updated_at: new Date().toISOString(),
		};

		const cacheService = new ProjectCacheService(c.env.PROJECTS_CACHE);
		await cacheService.setProjectConfig(projectConfig);
		await cacheService.clearNotFound(fullProject.slug, user.username);
	}

	return c.json({
		success: true,
		published_as: `${user.username}/${project.slug}`,
		fork_command: `jack new my-app -t ${user.username}/${project.slug}`,
	});
});

// Published project source (by owner/slug, requires auth)
api.get("/projects/:owner/:slug/source", async (c) => {
	const owner = c.req.param("owner");
	const slug = c.req.param("slug");

	const project = await c.env.DB.prepare(
		`SELECT * FROM projects WHERE owner_username = ? AND slug = ?
		 AND visibility = 'public' AND status != 'deleted'`,
	)
		.bind(owner, slug)
		.first<{ id: string; slug: string }>();

	if (!project) {
		return c.json({ error: "not_found", message: "Published project not found" }, 404);
	}

	return serveProjectSource(c.env, project);
});

// Stripe webhook handler (no auth - Stripe signs the request)
app.post("/v1/billing/webhook", async (c) => {
	const signature = c.req.header("stripe-signature");
	console.log("[webhook] Received webhook request");
	console.log("[webhook] Signature header:", signature?.substring(0, 50) + "...");
	console.log(
		"[webhook] Secret configured:",
		c.env.STRIPE_WEBHOOK_SECRET ? `${c.env.STRIPE_WEBHOOK_SECRET.substring(0, 10)}...` : "NOT SET",
	);

	if (!signature) {
		return c.json({ error: "invalid_request", message: "Missing stripe-signature header" }, 400);
	}

	const body = await c.req.text();
	console.log("[webhook] Body length:", body.length);
	const billingService = new BillingService(c.env);

	let event: Stripe.Event;
	try {
		event = await billingService.verifyWebhookSignature(
			body,
			signature,
			c.env.STRIPE_WEBHOOK_SECRET,
		);
		console.log("[webhook] Signature verified successfully, event type:", event.type);
	} catch (err) {
		console.error("[webhook] Signature verification failed:", err);
		console.error(
			"[webhook] This usually means the STRIPE_WEBHOOK_SECRET doesn't match the endpoint's signing secret",
		);
		return c.json({ error: "invalid_signature", message: "Invalid signature" }, 400);
	}

	try {
		switch (event.type) {
			case "customer.subscription.created":
			case "customer.subscription.updated": {
				const subscription = event.data.object as Stripe.Subscription;
				await billingService.syncFromStripeSubscription(subscription);
				// Qualify any pending referral on subscription activation
				const orgId = subscription.metadata.org_id;
				if (orgId && subscription.status === "active") {
					const creditsService = new CreditsService(c.env);
					await creditsService.qualifyReferral(orgId);
				}
				break;
			}
			case "customer.subscription.deleted":
				await billingService.handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
				break;
			default:
				console.log(`Unhandled webhook event: ${event.type}`);
		}

		return c.json({ received: true });
	} catch (error) {
		console.error("Webhook processing error:", error);
		return c.json({ error: "webhook_error", message: "Failed to process webhook" }, 500);
	}
});

// Daimo webhook handler (no auth - Daimo uses Basic auth token)
app.post("/v1/billing/daimo/webhook", async (c) => {
	const authHeader = c.req.header("authorization");
	console.log("[daimo-webhook] Received webhook request");

	const daimoService = new DaimoBillingService(c.env);

	if (!daimoService.verifyWebhook(authHeader)) {
		console.error("[daimo-webhook] Invalid or missing authorization");
		return c.json({ error: "unauthorized", message: "Invalid authorization" }, 401);
	}

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "invalid_request", message: "Invalid JSON body" }, 400);
	}

	const parsed = daimoService.parseWebhookPayload(body);
	if (!parsed) {
		console.error("[daimo-webhook] Missing required fields in payload:", body);
		return c.json({ error: "invalid_request", message: "Invalid webhook payload structure" }, 400);
	}

	console.log("[daimo-webhook] Event type:", parsed.type, "Payment ID:", parsed.paymentId);

	// Only process payment_completed events
	if (!daimoService.isPaymentCompletedEvent(parsed.type)) {
		console.log("[daimo-webhook] Ignoring non-completion event:", parsed.type);
		return c.json({ received: true, ignored: true });
	}

	// For payment_completed, we need org_id
	if (!parsed.orgId) {
		console.error("[daimo-webhook] Missing org_id in payment metadata for completed payment");
		return c.json({ error: "invalid_request", message: "Missing org_id in payment metadata" }, 400);
	}

	try {
		await daimoService.handlePaymentCompleted(parsed.paymentId, parsed.orgId);
		// Qualify any pending referral on payment completion
		const creditsService = new CreditsService(c.env);
		await creditsService.qualifyReferral(parsed.orgId);
		return c.json({ received: true });
	} catch (error) {
		console.error("[daimo-webhook] Processing error:", error);
		return c.json({ error: "webhook_error", message: "Failed to process webhook" }, 500);
	}
});

app.route("/v1", api);

async function sweepExpiredLogSessions(env: Bindings): Promise<void> {
	// Detach Tail Worker for expired sessions to avoid ongoing CPU costs.
	const expired = await env.DB.prepare(
		`SELECT s.id, r.resource_name AS worker_name
     FROM log_sessions s
     LEFT JOIN resources r
       ON r.project_id = s.project_id
      AND r.resource_type = 'worker'
      AND r.status != 'deleted'
     WHERE s.status = 'active'
       AND s.expires_at <= CURRENT_TIMESTAMP
     LIMIT 100`,
	).all<{ id: string; worker_name: string | null }>();

	const rows = expired.results ?? [];
	if (rows.length === 0) return;

	const cfClient = new CloudflareClient(env);
	for (const row of rows) {
		try {
			if (row.worker_name) {
				await cfClient.setDispatchScriptTailConsumers(
					LOG_TAIL_DISPATCH_NAMESPACE,
					row.worker_name,
					[],
				);
			}
			await env.DB.prepare("UPDATE log_sessions SET status = 'expired' WHERE id = ?")
				.bind(row.id)
				.run();
		} catch {
			// Retry on next cron tick.
		}
	}
}

async function pollPendingCustomDomains(env: Bindings): Promise<void> {
	const now = new Date();
	const nowStr = now.toISOString().replace("T", " ").replace("Z", "");

	// 1. Expire pending_dns domains older than 7 days
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const expiryThreshold = sevenDaysAgo.toISOString().replace("T", " ").replace("Z", "");
	await env.DB.prepare(
		`UPDATE custom_domains
     SET status = 'expired', updated_at = CURRENT_TIMESTAMP
     WHERE status = 'pending_dns' AND created_at < ?`,
	)
		.bind(expiryThreshold)
		.run();

	// 2. Poll pending_dns domains - verify DNS and transition to claimed if verified
	const pendingDns = await env.DB.prepare(
		`SELECT id, hostname FROM custom_domains
     WHERE status = 'pending_dns'
     LIMIT 10`,
	).all<{ id: string; hostname: string }>();

	for (const domain of pendingDns.results || []) {
		try {
			const dnsResult = await verifyDns(domain.hostname);

			if (dnsResult.verified) {
				// DNS verified - transition to 'claimed'
				await env.DB.prepare(
					`UPDATE custom_domains
           SET status = 'claimed',
               dns_verified = 1,
               dns_verified_at = ?,
               dns_last_checked_at = ?,
               dns_target = ?,
               dns_error = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(nowStr, nowStr, dnsResult.target, domain.id)
					.run();
			} else {
				// Update check timestamp and error
				await env.DB.prepare(
					`UPDATE custom_domains
           SET dns_last_checked_at = ?,
               dns_target = ?,
               dns_error = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(nowStr, dnsResult.target, dnsResult.error, domain.id)
					.run();
			}
		} catch (error) {
			console.error(`Failed to verify DNS for ${domain.hostname}:`, error);
		}
	}

	// 3. Poll pending_owner and pending_ssl domains (existing Cloudflare verification)
	const pendingCf = await env.DB.prepare(
		`SELECT cd.id, cd.hostname, cd.cloudflare_id, cd.project_id, p.status as project_status
     FROM custom_domains cd
     JOIN projects p ON p.id = cd.project_id
     WHERE cd.status IN ('pending_owner', 'pending_ssl')
       AND cd.cloudflare_id IS NOT NULL
     LIMIT 10`,
	).all<{
		id: string;
		hostname: string;
		cloudflare_id: string;
		project_id: string;
		project_status: string;
	}>();

	if (pendingCf.results?.length) {
		const cfClient = new CloudflareClient(env);
		cfClient.setZoneId(env.CLOUDFLARE_ZONE_ID);
		const cacheService = new ProjectCacheService(env.PROJECTS_CACHE);

		for (const domain of pendingCf.results) {
			try {
				const cfHostname = await cfClient.getCustomHostname(domain.cloudflare_id);
				if (!cfHostname) continue;

				const jackStatus = mapCloudflareToJackStatus(cfHostname.status, cfHostname.ssl?.status);

				await env.DB.prepare(
					`UPDATE custom_domains
           SET status = ?, ssl_status = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(jackStatus, cfHostname.ssl?.status || null, domain.id)
					.run();

				if (jackStatus === "active" && domain.project_status === "active") {
					const projectConfig = await cacheService.getProjectConfig(domain.project_id);
					if (projectConfig) {
						await cacheService.setCustomDomainConfig(domain.hostname, projectConfig);
					}
				}
			} catch (error) {
				console.error(`Failed to poll domain ${domain.hostname}:`, error);
			}
		}
	}

	// 4. Daily DNS drift check for active domains (check if DNS still points to us)
	// Only check domains that haven't been checked in the last 24 hours
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const driftCheckThreshold = oneDayAgo.toISOString().replace("T", " ").replace("Z", "");

	const activeDomains = await env.DB.prepare(
		`SELECT id, hostname FROM custom_domains
     WHERE status = 'active'
       AND (dns_last_checked_at IS NULL OR dns_last_checked_at < ?)
     LIMIT 5`,
	)
		.bind(driftCheckThreshold)
		.all<{ id: string; hostname: string }>();

	const cacheService = new ProjectCacheService(env.PROJECTS_CACHE);

	for (const domain of activeDomains.results || []) {
		try {
			const dnsResult = await verifyDns(domain.hostname);

			if (dnsResult.verified) {
				// DNS still valid - update check timestamp
				await env.DB.prepare(
					`UPDATE custom_domains
           SET dns_last_checked_at = ?,
               dns_target = ?,
               dns_error = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(nowStr, dnsResult.target, domain.id)
					.run();
			} else {
				// DNS drifted - mark as 'moved' and remove from cache
				await env.DB.prepare(
					`UPDATE custom_domains
           SET status = 'moved',
               dns_verified = 0,
               dns_last_checked_at = ?,
               dns_target = ?,
               dns_error = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
				)
					.bind(nowStr, dnsResult.target, dnsResult.error, domain.id)
					.run();

				// Remove from cache since domain no longer points to us
				await cacheService.deleteCustomDomainConfig(domain.hostname);
			}
		} catch (error) {
			console.error(`Failed to check DNS drift for ${domain.hostname}:`, error);
		}
	}
}

// =====================================================
// Cron Schedule Runner
// =====================================================

interface CronScheduleRow {
	id: string;
	project_id: string;
	expression: string;
	expression_normalized: string;
	worker_name: string;
	cron_secret: string | null;
}

async function processDueCronSchedules(env: Bindings, ctx: ExecutionContext): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();
	const nowD1 = nowIso.replace("T", " ").replace("Z", "");

	// 1. Reset stuck runs (is_running=1 and run_started_at > 5 minutes ago)
	const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
	const stuckThreshold = fiveMinutesAgo.toISOString().replace("T", " ").replace("Z", "");

	await env.DB.prepare(
		`UPDATE cron_schedules
     SET is_running = 0,
         last_run_status = 'timeout',
         consecutive_failures = consecutive_failures + 1
     WHERE is_running = 1 AND run_started_at < ?`,
	)
		.bind(stuckThreshold)
		.run();

	// 2. Get candidates (not yet claimed, due to run)
	const candidates = await env.DB.prepare(
		`SELECT cs.id, cs.project_id, cs.expression, cs.expression_normalized,
            r.resource_name as worker_name, p.cron_secret
     FROM cron_schedules cs
     JOIN projects p ON cs.project_id = p.id
     JOIN resources r ON r.project_id = p.id AND r.resource_type = 'worker' AND r.status != 'deleted'
     WHERE cs.enabled = 1
       AND cs.is_running = 0
       AND cs.next_run_at <= ?
       AND p.status = 'active'
     ORDER BY cs.next_run_at
     LIMIT 50`,
	)
		.bind(nowD1)
		.all<CronScheduleRow>();

	if (!candidates.results?.length) return;

	// 3. Process each candidate
	for (const schedule of candidates.results) {
		// ATOMIC CLAIM - prevents race condition
		const claimed = await env.DB.prepare(
			`UPDATE cron_schedules SET is_running = 1, run_started_at = ?
       WHERE id = ? AND is_running = 0`,
		)
			.bind(nowD1, schedule.id)
			.run();

		if (claimed.meta.changes === 0) {
			// Already claimed by another worker
			continue;
		}

		// Execute in background
		ctx.waitUntil(executeCronSchedule(env, schedule));
	}
}

async function executeCronSchedule(env: Bindings, schedule: CronScheduleRow): Promise<void> {
	const startTime = Date.now();
	let status = "success";

	try {
		const worker = env.TENANT_DISPATCH.get(schedule.worker_name);

		// Build signed request
		const cronSecret = schedule.cron_secret || "";
		const timestamp = Date.now().toString();
		const payload = `${timestamp}.POST./__scheduled.${schedule.expression_normalized}`;
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(cronSecret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
		const signature = Array.from(new Uint8Array(sig))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");

		const response = await worker.fetch(
			new Request("https://internal/__scheduled", {
				method: "POST",
				headers: {
					"X-Jack-Cron": schedule.expression_normalized,
					"X-Jack-Timestamp": timestamp,
					"X-Jack-Signature": signature,
				},
			}),
		);

		// CHECK RESPONSE STATUS - don't assume success
		if (!response.ok) {
			status = `error:${response.status}`;
			console.error(`Cron ${schedule.id} returned ${response.status}`);
		}
	} catch (error) {
		status = "error:exception";
		console.error(`Cron ${schedule.id} failed:`, error);
	}

	// ALWAYS release lock and update status
	const duration = Date.now() - startTime;
	const isFailure = !status.startsWith("success");

	// Compute next run time
	let nextRun: string;
	try {
		const cronParser = await import("cron-parser");
		const interval = cronParser.parseExpression(schedule.expression_normalized);
		nextRun = interval.next().toDate().toISOString();
	} catch {
		// If parsing fails, set next run to 1 hour from now
		nextRun = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	}

	const nowD1 = new Date().toISOString().replace("T", " ").replace("Z", "");
	const nextRunD1 = nextRun.replace("T", " ").replace("Z", "");

	await env.DB.prepare(
		`UPDATE cron_schedules
     SET is_running = 0,
         run_started_at = NULL,
         last_run_at = ?,
         last_run_status = ?,
         last_run_duration_ms = ?,
         next_run_at = ?,
         consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END
     WHERE id = ?`,
	)
		.bind(nowD1, status, duration, nextRunD1, isFailure ? 1 : 0, schedule.id)
		.run();
}

const handler: ExportedHandler<Bindings> = {
	fetch: app.fetch,
	scheduled: (_event, env, ctx) => {
		ctx.waitUntil(sweepExpiredLogSessions(env));
		ctx.waitUntil(pollPendingCustomDomains(env));
		ctx.waitUntil(processDueCronSchedules(env, ctx));
		ctx.waitUntil(processDoMetering(env));
	},
};

export default handler;

async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyApiToken(token: string, db: D1Database): Promise<AuthContext> {
	const hexPart = token.slice(4); // Remove "jkt_" prefix
	const idPrefix = hexPart.slice(0, 8);
	const tokenHash = await hashToken(token);

	const { results } = await db
		.prepare(
			`SELECT id, user_id, org_id, token_hash, expires_at
			 FROM api_tokens
			 WHERE id_prefix = ? AND revoked_at IS NULL`,
		)
		.bind(idPrefix)
		.all<{
			id: string;
			user_id: string;
			org_id: string;
			token_hash: string;
			expires_at: string | null;
		}>();

	const matched = results.find((r) => r.token_hash === tokenHash);
	if (!matched) {
		throw new Error("Invalid API token");
	}

	if (matched.expires_at && new Date(matched.expires_at) < new Date()) {
		throw new Error("API token has expired");
	}

	// Look up user info (include workos_user_id to avoid a second query)
	const user = await db
		.prepare("SELECT id, email, first_name, last_name, workos_user_id FROM users WHERE id = ?")
		.bind(matched.user_id)
		.first<{
			id: string;
			email: string;
			first_name: string | null;
			last_name: string | null;
			workos_user_id: string;
		}>();

	if (!user) {
		throw new Error("Token owner not found");
	}

	const org = await db
		.prepare("SELECT workos_org_id FROM orgs WHERE id = ?")
		.bind(matched.org_id)
		.first<{ workos_org_id: string }>();

	// Fire-and-forget: update last_used_at
	db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?")
		.bind(matched.id)
		.run();

	return {
		userId: user.id,
		orgId: matched.org_id,
		workosUserId: user.workos_user_id,
		workosOrgId: org?.workos_org_id,
		email: user.email,
		firstName: user.first_name ?? undefined,
		lastName: user.last_name ?? undefined,
	};
}

async function verifyAuth(token: string, db: D1Database): Promise<AuthContext> {
	if (token.startsWith("jkt_")) {
		return verifyApiToken(token, db);
	}

	const payload = (await verifyJwt(token)) as WorkosJwtPayload;
	if (!payload.sub) {
		throw new Error("Missing subject in token");
	}

	// WorkOS JWTs don't include user info - look up from DB
	const existingUser = await db
		.prepare("SELECT id, email, first_name, last_name FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string; email: string; first_name: string | null; last_name: string | null }>();

	if (!existingUser) {
		// New user - they need to have logged in via CLI first which stores user info
		throw new Error("User not found. Please login via CLI first.");
	}

	const org = await ensureOrgForUser(db, existingUser.id, payload);

	return {
		userId: existingUser.id,
		orgId: org.orgId,
		workosUserId: payload.sub,
		workosOrgId: org.workosOrgId,
		email: existingUser.email,
		firstName: existingUser.first_name ?? undefined,
		lastName: existingUser.last_name ?? undefined,
	};
}

async function ensureUser(db: D1Database, payload: WorkosJwtPayload): Promise<string> {
	const existing = await db
		.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	const userId = existing?.id ?? `usr_${crypto.randomUUID()}`;

	await db
		.prepare(
			`INSERT INTO users (id, workos_user_id, email, first_name, last_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workos_user_id) DO UPDATE SET
         email = excluded.email,
         first_name = excluded.first_name,
         last_name = excluded.last_name,
         updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(userId, payload.sub, payload.email, payload.first_name ?? null, payload.last_name ?? null)
		.run();

	const row = await db
		.prepare("SELECT id FROM users WHERE workos_user_id = ?")
		.bind(payload.sub)
		.first<{ id: string }>();

	if (!row?.id) {
		throw new Error("Failed to resolve user");
	}

	return row.id;
}

async function ensureOrgForUser(
	db: D1Database,
	userId: string,
	payload: WorkosJwtPayload,
): Promise<{ orgId: string; workosOrgId: string | null }> {
	if (payload.org_id) {
		const org = await db
			.prepare("SELECT id FROM orgs WHERE workos_org_id = ?")
			.bind(payload.org_id)
			.first<{ id: string }>();

		const orgId = org?.id ?? `org_${crypto.randomUUID()}`;
		if (!org?.id) {
			await db
				.prepare("INSERT INTO orgs (id, workos_org_id, name) VALUES (?, ?, ?)")
				.bind(orgId, payload.org_id, defaultOrgName(payload))
				.run();
		}

		await ensureMembership(db, orgId, userId);
		return { orgId, workosOrgId: payload.org_id };
	}

	const existing = await db
		.prepare(
			`SELECT orgs.id as org_id, orgs.workos_org_id as workos_org_id
       FROM orgs
       JOIN org_memberships ON orgs.id = org_memberships.org_id
       WHERE org_memberships.user_id = ?
       ORDER BY org_memberships.created_at ASC
       LIMIT 1`,
		)
		.bind(userId)
		.first<{ org_id: string; workos_org_id: string | null }>();

	if (existing?.org_id) {
		return { orgId: existing.org_id, workosOrgId: existing.workos_org_id ?? null };
	}

	const orgId = `org_${crypto.randomUUID()}`;
	await db
		.prepare("INSERT INTO orgs (id, name) VALUES (?, ?)")
		.bind(orgId, defaultOrgName(payload))
		.run();

	await ensureMembership(db, orgId, userId);
	return { orgId, workosOrgId: null };
}

async function ensureMembership(db: D1Database, orgId: string, userId: string) {
	await db
		.prepare(
			`INSERT INTO org_memberships (id, org_id, user_id, role)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(org_id, user_id) DO NOTHING`,
		)
		.bind(`orgmem_${crypto.randomUUID()}`, orgId, userId, "owner")
		.run();
}

function defaultOrgName(payload: WorkosJwtPayload): string {
	const base = payload.first_name ?? payload.email?.split("@")[0] ?? "Personal";
	return `${base}'s Workspace`;
}

type AnalyticsRange = {
	from: string;
	to: string;
};

type AnalyticsRangeResult = { ok: true; range: AnalyticsRange } | { ok: false; message: string };

function resolveAnalyticsRange(c: {
	req: { query: (key: string) => string | undefined };
}): AnalyticsRangeResult {
	const fromParam = c.req.query("from");
	const toParam = c.req.query("to");
	const preset = c.req.query("preset") ?? "last_7d";
	const now = new Date();

	if (fromParam || toParam) {
		if (!fromParam || !toParam) {
			return { ok: false, message: "from and to must both be provided" };
		}

		const fromDate = new Date(fromParam);
		const toDate = new Date(toParam);

		if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
			return { ok: false, message: "from and to must be valid ISO timestamps" };
		}

		if (fromDate > toDate) {
			return { ok: false, message: "from must be before to" };
		}

		return {
			ok: true,
			range: { from: fromDate.toISOString(), to: toDate.toISOString() },
		};
	}

	if (preset !== "last_24h" && preset !== "last_7d" && preset !== "mtd") {
		return { ok: false, message: "preset must be one of last_24h, last_7d, mtd" };
	}

	let fromDate: Date;
	if (preset === "last_24h") {
		fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	} else if (preset === "mtd") {
		fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	} else {
		fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	}

	return {
		ok: true,
		range: { from: fromDate.toISOString(), to: now.toISOString() },
	};
}
