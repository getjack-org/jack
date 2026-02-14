import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings } from "./types.ts";

type AuthBindings = Bindings & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: AuthBindings }>();

app.use("/*", cors({
	origin: "*",
	allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
	allowHeaders: ["Content-Type", "Authorization", "Accept"],
}));

// GET /authorize — MCP client redirects here. Parse OAuth request, stash in KV,
// redirect to WorkOS AuthKit hosted login page.
app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request: missing client_id", 400);
	}

	const stateToken = crypto.randomUUID();
	await c.env.OAUTH_KV.put(
		`oauth_state:${stateToken}`,
		JSON.stringify(oauthReqInfo),
		{ expirationTtl: 600 },
	);

	const redirectUri = new URL("/callback", c.req.url).href;
	const params = new URLSearchParams({
		client_id: c.env.WORKOS_CLIENT_ID,
		redirect_uri: redirectUri,
		response_type: "code",
		state: stateToken,
		provider: "authkit",
	});

	return c.redirect(`https://api.workos.com/user_management/authorize?${params}`);
});

// GET /callback — WorkOS redirects here after login. Exchange code for tokens,
// complete the OAuth flow back to the MCP client.
app.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const error = c.req.query("error");

	if (error) {
		return c.text(`Login failed: ${c.req.query("error_description") || error}`, 400);
	}
	if (!code || !state) {
		return c.text("Missing code or state parameter", 400);
	}

	const stored = await c.env.OAUTH_KV.get(`oauth_state:${state}`);
	if (!stored) {
		return c.text("Invalid or expired state. Please try connecting again.", 400);
	}
	await c.env.OAUTH_KV.delete(`oauth_state:${state}`);
	const oauthReqInfo: AuthRequest = JSON.parse(stored);

	const tokenResponse = await fetch(
		"https://api.workos.com/user_management/authenticate",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: c.env.WORKOS_CLIENT_ID,
				client_secret: c.env.WORKOS_API_KEY,
				grant_type: "authorization_code",
				code,
			}),
		},
	);

	if (!tokenResponse.ok) {
		const errBody = await tokenResponse.text();
		console.log(JSON.stringify({ event: "workos_token_error", status: tokenResponse.status, body: errBody }));
		return c.text("Failed to exchange authorization code. Please try again.", 500);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token: string;
		refresh_token: string;
		user: { id: string; email: string };
	};

	// Ensure user exists in control plane (idempotent upsert)
	const controlPlaneUrl = c.env.CONTROL_PLANE_URL || "https://control.getjack.org";
	await fetch(`${controlPlaneUrl}/v1/register`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${tokenData.access_token}`,
		},
		body: JSON.stringify({ email: tokenData.user.email }),
	}).catch((err) => {
		console.log(JSON.stringify({ event: "register_error", error: String(err) }));
	});

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: tokenData.user.id,
		metadata: { label: tokenData.user.email },
		scope: oauthReqInfo.scope,
		props: {
			accessToken: tokenData.access_token,
			refreshToken: tokenData.refresh_token,
			userId: tokenData.user.id,
			email: tokenData.user.email,
		},
	});

	return c.redirect(redirectTo, 302);
});

app.get("/.well-known/mcp/server-card.json", (c) => {
	return c.json({
		name: "Jack",
		description: "Deploy and manage web apps, databases, and cron jobs from any AI assistant.",
		url: "https://mcp.getjack.org/mcp",
		documentation_url: "https://docs.getjack.org",
		icons: [
			{ url: "https://docs.getjack.org/jack-logo.png", media_type: "image/png" },
			{ url: "https://docs.getjack.org/jack-logo-square.svg", media_type: "image/svg+xml" },
		],
		tools_count: 10,
		authentication: {
			type: "oauth2",
			authorization_url: "https://mcp.getjack.org/authorize",
			token_url: "https://mcp.getjack.org/token",
		},
	});
});

app.get("/", (c) => {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jack MCP Server</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { margin-bottom: 4px; }
  h1 a { color: inherit; text-decoration: none; }
  .subtitle { color: #666; margin-top: 0; }
  h2 { margin-top: 32px; border-bottom: 1px solid #e5e5e5; padding-bottom: 4px; }
  pre { background: #f5f5f5; padding: 12px 16px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: 13px; }
  p code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; }
  a { color: #2563eb; }
</style>
</head>
<body>
<h1><a href="https://getjack.org">Jack MCP Server</a></h1>
<p class="subtitle">Deploy and manage web apps from any AI assistant.</p>

<h2>Claude Desktop / Claude.ai</h2>
<p>Add as a custom connector — Claude handles OAuth automatically:</p>
<ol>
<li>Open Settings &rarr; Connectors &rarr; Add MCP Server</li>
<li>Enter URL: <code>https://mcp.getjack.org/mcp</code></li>
<li>Log in with your Jack account when prompted</li>
</ol>

<h2>Claude Code</h2>
<pre>claude mcp add --transport http jack https://mcp.getjack.org/mcp</pre>

<h2>ChatGPT</h2>
<ol>
<li>Open ChatGPT &rarr; Settings &rarr; Developer Mode &rarr; Enable</li>
<li>Add MCP server with URL: <code>https://mcp.getjack.org/mcp</code></li>
<li>Log in with your Jack account when prompted</li>
</ol>

<h2>Windsurf</h2>
<p>Add to <code>~/.windsurf/mcp.json</code>:</p>
<pre>{
  "mcpServers": {
    "jack": {
      "serverUrl": "https://mcp.getjack.org/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}</pre>

<h2>Manual Token Setup</h2>
<p>For clients that don't support OAuth, use a Bearer token:</p>
<p>Get one at <a href="https://dash.getjack.org">dash.getjack.org</a> &rarr; Settings &rarr; API Tokens, or run <code>npx @getjack/jack login</code>.</p>

<p style="margin-top:40px;color:#999;font-size:13px">
  <a href="/.well-known/mcp/server-card.json">server-card.json</a> &middot;
  <a href="https://docs.getjack.org">Docs</a> &middot;
  <a href="https://getjack.org">getjack.org</a>
</p>
</body>
</html>`;
	return c.html(html);
});

export { app as AuthHandler };
