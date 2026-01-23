import { z } from "zod";
import { executeTool, getToolsList } from "./tools";

const McpRequestSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number()]),
	method: z.string(),
	params: z.record(z.unknown()).optional(),
});

type McpRequest = z.infer<typeof McpRequestSchema>;

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number;
	result?: unknown;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

function createResponse(id: string | number, result: unknown): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		result,
	};
}

function createErrorResponse(
	id: string | number,
	code: number,
	message: string,
	data?: unknown
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: {
			code,
			message,
			...(data !== undefined && { data }),
		},
	};
}

export async function mcpHandler(
	body: unknown,
	request: Request
): Promise<JsonRpcResponse> {
	const parseResult = McpRequestSchema.safeParse(body);

	if (!parseResult.success) {
		return createErrorResponse(
			0,
			-32600,
			"Invalid Request",
			parseResult.error.errors
		);
	}

	const { id, method, params } = parseResult.data;

	switch (method) {
		case "tools/list": {
			const tools = getToolsList();
			return createResponse(id, { tools });
		}

		case "tools/call": {
			const toolName = params?.name as string | undefined;
			const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

			if (!toolName) {
				return createErrorResponse(id, -32602, "Invalid params: missing tool name");
			}

			try {
				const result = await executeTool(toolName, toolArgs, request);
				return createResponse(id, result);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				return createErrorResponse(id, -32603, message);
			}
		}

		default:
			return createErrorResponse(id, -32601, `Method not found: ${method}`);
	}
}
