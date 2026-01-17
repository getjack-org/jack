import { type LoginFlowOptions, runLoginFlow } from "../lib/auth/login-flow.ts";

interface LoginOptions {
	/** Skip the initial "Logging in..." message (used when called from auto-login) */
	silent?: boolean;
}

export default async function login(options: LoginOptions = {}): Promise<void> {
	const flowOptions: LoginFlowOptions = {
		silent: options.silent,
	};

	const result = await runLoginFlow(flowOptions);

	if (!result.success) {
		process.exit(1);
	}
}
