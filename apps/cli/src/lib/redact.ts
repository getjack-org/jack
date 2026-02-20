import { KNOWN_SECRET_KEYS, SECRET_KEY_PATTERNS } from "./env-parser.ts";

/**
 * Prefixed API tokens — covers Stripe, GitHub, GitLab, Slack, jack, etc.
 */
const PREFIXED_TOKEN_RE =
	/\b(sk|pk|rk|jkt|ghp|gho|ghu|ghs|ghr|glpat|xoxb|xoxp|xapp|whsec|sk_live|pk_live|sk_test|pk_test)[_-][A-Za-z0-9_-]{8,}\b/g;

/**
 * AWS Access Key IDs — always start with AKIA.
 */
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

/**
 * JWTs — three base64url segments starting with eyJ (base64 of '{"').
 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Bearer tokens in Authorization headers / logs.
 */
const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g;

/**
 * Database / service connection strings with credentials.
 */
const CONNECTION_STRING_RE = /(postgres|mysql|redis|mongodb(\+srv)?):\/\/[^\s"']+/g;

/**
 * HTTP(S) URLs with embedded credentials (user:pass@host).
 */
const CREDENTIAL_URL_RE = /https?:\/\/[^@/\s]+:[^@/\s]+@[^\s"']+/g;

/**
 * PEM-encoded private keys.
 */
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/**
 * Build a regex that matches env-style assignments where the key looks secret.
 * Matches: SECRET_KEY=value, SECRET_KEY="value", SECRET_KEY: 'value'
 */
function buildSecretAssignmentRe(): RegExp {
	const exactKeys = KNOWN_SECRET_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
		"|",
	);
	const patternSuffixes = SECRET_KEY_PATTERNS.map((re) => {
		// Strip anchors (^ / $) from the env-parser patterns
		const src = re.source.replace(/^\^|\$$/g, "");
		return `[A-Z_]*${src}`;
	}).join("|");

	return new RegExp(
		`\\b(${exactKeys}|${patternSuffixes})\\s*[:=]\\s*["']?[^\\s"']{8,}["']?`,
		"gi",
	);
}

/**
 * Build a regex that matches quoted values after secret-like JSON keys.
 * Matches: "jwt_secret": "a8f3...", 'API_KEY': 'longvalue'
 */
function buildJsonSecretValueRe(): RegExp {
	const exactKeys = KNOWN_SECRET_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(
		"|",
	);
	const patternSuffixes = SECRET_KEY_PATTERNS.map((re) => {
		const src = re.source.replace(/^\^|\$$/g, "");
		return `[A-Za-z_]*${src}`;
	}).join("|");

	return new RegExp(
		`(["'])(${exactKeys}|${patternSuffixes})\\1\\s*:\\s*(["'])([^"']{8,})\\3`,
		"gi",
	);
}

const SECRET_ASSIGNMENT_RE = buildSecretAssignmentRe();
const JSON_SECRET_VALUE_RE = buildJsonSecretValueRe();

/**
 * Redact sensitive data from a string.
 *
 * Pure, stateless, and fast. Designed to be applied to transcript lines
 * before upload so secrets never leave the CLI.
 */
export function redactSensitiveData(input: string): string {
	let result = input;

	// Order matters: private keys first (multi-line), then specific patterns, then general

	// PEM private keys (may span multiple lines in JSON-encoded content)
	result = result.replace(PRIVATE_KEY_RE, "[REDACTED-PRIVATE-KEY]");

	// Connection strings (before general token matching to avoid partial matches)
	result = result.replace(CONNECTION_STRING_RE, "[REDACTED-URL]");

	// HTTP(S) URLs with embedded credentials
	result = result.replace(CREDENTIAL_URL_RE, "[REDACTED-URL]");

	// AWS Access Key IDs
	result = result.replace(AWS_KEY_RE, "[REDACTED]");

	// JWTs (three dot-separated base64url segments)
	result = result.replace(JWT_RE, "[REDACTED]");

	// Prefixed API tokens (sk_live_xxx, ghp_xxx, etc.)
	result = result.replace(PREFIXED_TOKEN_RE, "[REDACTED]");

	// Bearer tokens
	result = result.replace(BEARER_TOKEN_RE, "Bearer [REDACTED]");

	// JSON-style secret values: "API_KEY": "value" → "API_KEY": "[REDACTED]"
	result = result.replace(JSON_SECRET_VALUE_RE, (_, q1, key, q2) => {
		return `${q1}${key}${q1}: ${q2}[REDACTED]${q2}`;
	});

	// Env-style assignments: API_KEY=value → API_KEY=[REDACTED]
	// Reset lastIndex since we're reusing the regex
	SECRET_ASSIGNMENT_RE.lastIndex = 0;
	result = result.replace(SECRET_ASSIGNMENT_RE, (match) => {
		const sepIndex = match.search(/\s*[:=]\s*/);
		if (sepIndex === -1) return match;
		const key = match.slice(0, sepIndex);
		return `${key}=[REDACTED]`;
	});

	return result;
}
