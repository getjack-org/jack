import * as jose from "jose";
import {
	WORKOS_JWKS_URL,
	WORKOS_ISSUER,
	WORKOS_CLIENT_ID,
	DEFAULT_CACHE_TTL_MS,
} from "./constants.ts";
import type { JwtPayload, JwksVerifierOptions, CachedJwks } from "./types.ts";

// In-memory JWKS cache
let jwksCache: CachedJwks | null = null;

/**
 * Create a JWKS verifier with caching
 */
export function createJwksVerifier(options: JwksVerifierOptions = {}) {
	const {
		jwksUrl = WORKOS_JWKS_URL,
		issuer = WORKOS_ISSUER,
		audience = WORKOS_CLIENT_ID,
		cacheTtlMs = DEFAULT_CACHE_TTL_MS,
	} = options;

	return {
		async verify(token: string): Promise<JwtPayload> {
			// Check cache validity
			const now = Date.now();
			if (!jwksCache || now - jwksCache.fetchedAt > cacheTtlMs) {
				const response = await fetch(jwksUrl);
				if (!response.ok) {
					throw new Error(`Failed to fetch JWKS: ${response.status}`);
				}
				const data = (await response.json()) as { keys: JsonWebKey[] };
				jwksCache = {
					keys: data.keys,
					fetchedAt: now,
				};
			}

			// Create JWKS from cached keys
			const JWKS = jose.createLocalJWKSet({ keys: jwksCache.keys });

			// Verify the token
			const { payload } = await jose.jwtVerify(token, JWKS, {
				issuer,
				audience,
			});

			return payload as unknown as JwtPayload;
		},

		clearCache() {
			jwksCache = null;
		},
	};
}

// Default verifier instance
const defaultVerifier = createJwksVerifier();

/**
 * Verify a JWT token using the default verifier
 */
export async function verifyJwt(token: string): Promise<JwtPayload> {
	return defaultVerifier.verify(token);
}
