import { getAuthApiUrl } from "./constants.ts";
import { type AuthCredentials, getCredentials, isTokenExpired, saveCredentials } from "./store.ts";

export interface DeviceAuthResponse {
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
	user: {
		id: string;
		email: string;
		first_name: string | null;
		last_name: string | null;
	};
}

export async function startDeviceAuth(): Promise<DeviceAuthResponse> {
	const response = await fetch(`${getAuthApiUrl()}/auth/device/authorize`, {
		method: "POST",
	});

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.message || "Failed to start device authorization");
	}

	return response.json();
}

export async function pollDeviceToken(deviceCode: string): Promise<TokenResponse | null> {
	const response = await fetch(`${getAuthApiUrl()}/auth/device/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ device_code: deviceCode }),
	});

	if (response.status === 202) {
		return null;
	}

	if (response.status === 410) {
		throw new Error("Device code expired. Please try again.");
	}

	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.message || "Failed to get token");
	}

	return response.json();
}

export async function refreshToken(refreshTokenValue: string): Promise<TokenResponse> {
	const response = await fetch(`${getAuthApiUrl()}/auth/refresh`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refresh_token: refreshTokenValue }),
	});

	if (!response.ok) {
		throw new Error("Failed to refresh token. Please login again.");
	}

	return response.json();
}

export async function getValidAccessToken(): Promise<string | null> {
	const creds = await getCredentials();
	if (!creds) {
		return null;
	}

	if (isTokenExpired(creds)) {
		try {
			const newTokens = await refreshToken(creds.refresh_token);
			// Default to 5 minutes if expires_in not provided
			const expiresIn = newTokens.expires_in ?? 300;
			const newCreds: AuthCredentials = {
				access_token: newTokens.access_token,
				refresh_token: newTokens.refresh_token,
				expires_at: Math.floor(Date.now() / 1000) + expiresIn,
				user: newTokens.user,
			};
			await saveCredentials(newCreds);
			return newCreds.access_token;
		} catch {
			return null;
		}
	}

	return creds.access_token;
}

export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
	const token = await getValidAccessToken();
	if (!token) {
		throw new Error("Not authenticated. Run 'jack login' first.");
	}

	return fetch(url, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${token}`,
		},
	});
}
