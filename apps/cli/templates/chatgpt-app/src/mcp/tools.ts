export interface McpTool {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

const tools: McpTool[] = [
	{
		name: "get_greeting",
		description: "Generate a personalized greeting with an interactive widget",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "The name of the person to greet",
				},
				style: {
					type: "string",
					enum: ["formal", "casual", "fun"],
					description: "The style of the greeting",
				},
			},
			required: ["name"],
		},
	},
	{
		name: "show_chart",
		description: "Display data as an interactive chart widget",
		inputSchema: {
			type: "object",
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						properties: {
							label: { type: "string" },
							value: { type: "number" },
						},
						required: ["label", "value"],
					},
					description: "Array of data points with label and value",
				},
				title: {
					type: "string",
					description: "Title for the chart",
				},
			},
			required: ["data"],
		},
	},
];

export function getToolsList(): McpTool[] {
	return tools;
}

function getBaseUrl(request: Request): string {
	const forwardedProto = request.headers.get("x-forwarded-proto");
	const forwardedHost = request.headers.get("x-forwarded-host");

	if (forwardedProto && forwardedHost) {
		return `${forwardedProto}://${forwardedHost}`;
	}

	const url = new URL(request.url);
	return `${url.protocol}//${url.host}`;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	_meta?: {
		"openai/outputTemplate"?: {
			url: string;
			params: Record<string, unknown>;
		};
	};
}

export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	request: Request
): Promise<ToolResult> {
	const baseUrl = getBaseUrl(request);

	switch (name) {
		case "get_greeting": {
			const personName = (args.name as string) || "Guest";
			const style = (args.style as string) || "casual";

			let greeting: string;
			switch (style) {
				case "formal":
					greeting = `Good day, ${personName}. It is a pleasure to make your acquaintance.`;
					break;
				case "fun":
					greeting = `Hey ${personName}! So awesome to meet you! 🎉`;
					break;
				case "casual":
				default:
					greeting = `Hi ${personName}! Nice to meet you.`;
					break;
			}

			return {
				content: [{ type: "text", text: greeting }],
				_meta: {
					"openai/outputTemplate": {
						url: `${baseUrl}/widgets/greeting`,
						params: { name: personName, style, greeting },
					},
				},
			};
		}

		case "show_chart": {
			const data = (args.data as Array<{ label: string; value: number }>) || [];
			const title = (args.title as string) || "Chart";

			const summary = data
				.map((d) => `${d.label}: ${d.value}`)
				.join(", ");

			return {
				content: [{ type: "text", text: `Chart "${title}" with data: ${summary}` }],
				_meta: {
					"openai/outputTemplate": {
						url: `${baseUrl}/widgets/chart`,
						params: { data, title },
					},
				},
			};
		}

		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}
