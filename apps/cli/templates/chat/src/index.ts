import { routeAgentRequest } from "agents";

export { Chat } from "./chat-agent";

interface Env {
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	ASSETS: Fetcher;
	Chat: DurableObjectNamespace;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({ status: "ok", timestamp: Date.now() });
		}

		const agentResponse = await routeAgentRequest(request, env);
		if (agentResponse !== null) return agentResponse;

		return env.ASSETS.fetch(request);
	},
};
