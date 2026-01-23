import { Hono } from "hono";
import { cors } from "hono/cors";
import { mcpHandler } from "./mcp/handler";
import { getToolsList } from "./mcp/tools";
import { serveWidget } from "./lib/widget-server";

type Env = {
	ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/health", (c) => {
	return c.json({ status: "ok" });
});

app.post("/mcp", async (c) => {
	const body = await c.req.json();
	const response = await mcpHandler(body, c.req.raw);
	return c.json(response);
});

app.get("/mcp", (c) => {
	return c.json({
		name: "chatgpt-app-mcp",
		version: "1.0.0",
		description: "MCP server with widget output support",
		tools: getToolsList(),
	});
});

app.get("/widgets/:name", async (c) => {
	const widgetName = c.req.param("name");
	return serveWidget(c.env.ASSETS, widgetName);
});

export default app;
