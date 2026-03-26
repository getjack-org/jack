export type Bindings = {
	CONTROL_PLANE_URL: string;
	WORKOS_CLIENT_ID: string;
	WORKOS_API_KEY: string;
	OAUTH_KV: KVNamespace;
	LOADER: {
		get(
			id: string,
			factory: () => Promise<{
				mainModule: string;
				modules: Record<string, string>;
				compatibilityDate: string;
				compatibilityFlags?: string[];
				env?: Record<string, unknown>;
				globalOutbound?: null;
			}>,
		): Promise<{
			getEntrypoint(name?: string): { run(input: unknown): Promise<unknown> };
		}>;
	};
	COMPUTE_SESSION: DurableObjectNamespace;
	MPP_SECRET_KEY: string;
	TEMPO_RECIPIENT: string;
};

export type Props = {
	accessToken: string;
	refreshToken: string;
	userId: string;
	email: string;
};
