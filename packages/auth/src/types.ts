export interface JwtPayload {
	sub: string; // User ID
	email: string;
	iss: string; // Issuer (WorkOS)
	aud: string; // Audience (client ID)
	exp: number; // Expiration timestamp
	iat: number; // Issued at timestamp
	first_name?: string;
	last_name?: string;
}

export interface AuthContext {
	userId: string;
	email: string;
	firstName?: string;
	lastName?: string;
	// Optional fields for downstream services that enrich auth context.
	orgId?: string;
	workosUserId?: string;
	workosOrgId?: string | null;
}

export interface JwksVerifierOptions {
	jwksUrl?: string;
	issuer?: string;
	audience?: string;
	cacheTtlMs?: number;
}

export interface CachedJwks {
	keys: JsonWebKey[];
	fetchedAt: number;
}
