export const AUTH_API_URL = "https://auth.getjack.org";

export function getAuthApiUrl(): string {
	return process.env.JACK_AUTH_URL || AUTH_API_URL;
}
