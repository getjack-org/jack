export { getAuthApiUrl } from "./constants.ts";
export {
	getValidAccessToken,
	authFetch,
	pollDeviceToken,
	refreshToken,
	startDeviceAuth,
	startMagicAuth,
	verifyMagicAuth,
	type MagicAuthStartResponse,
} from "./client.ts";
export {
	ensureAuthForCreate,
	type EnsureAuthOptions,
	type EnsureAuthResult,
} from "./ensure-auth.ts";
export { requireAuth, requireAuthOrLogin, getCurrentUser } from "./guard.ts";
export {
	runLoginFlow,
	runMagicAuthFlow,
	type LoginFlowOptions,
	type LoginFlowResult,
	type MagicAuthFlowOptions,
	type MagicAuthFlowResult,
} from "./login-flow.ts";
export {
	deleteCredentials,
	getAuthState,
	getCredentials,
	isLoggedIn,
	isTokenExpired,
	saveCredentials,
	type AuthCredentials,
	type AuthState,
	type AuthUser,
} from "./store.ts";
