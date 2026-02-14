export type Bindings = {
	CONTROL_PLANE_URL: string;
	WORKOS_CLIENT_ID: string;
	WORKOS_API_KEY: string;
	OAUTH_KV: KVNamespace;
};

export type Props = {
	accessToken: string;
	userId: string;
	email: string;
};
