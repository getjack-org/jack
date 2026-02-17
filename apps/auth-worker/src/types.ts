export interface DeviceAuthorizationResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: "Bearer";
	user: {
		id: string;
		email: string;
		first_name: string | null;
		last_name: string | null;
		email_verified: boolean;
		profile_picture_url: string | null;
		created_at: string;
		updated_at: string;
	};
}

export interface AuthorizationPendingResponse {
	error: "authorization_pending";
	error_description: string;
}

export interface MagicAuthResponse {
	id: string;
	user_id: string;
	email: string;
	expires_at: string;
	code: string; // present in WorkOS response but we NEVER return this
	created_at: string;
	updated_at: string;
}

export interface WorkOSErrorResponse {
	error: string;
	error_description: string;
}

export interface DeviceAuthorizeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface DeviceTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	user: {
		id: string;
		email: string;
		first_name: string | null;
		last_name: string | null;
	};
}
