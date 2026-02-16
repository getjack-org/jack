export type McpToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

export function ok(data: unknown): McpToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify({ success: true, data }) }],
	};
}

export function err(
	code: string,
	message: string,
	suggestion?: string,
	data?: Record<string, unknown>,
): McpToolResult {
	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					success: false,
					error: { code, message, suggestion },
					...data,
				}),
			},
		],
		isError: true,
	};
}
