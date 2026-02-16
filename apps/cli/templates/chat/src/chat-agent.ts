import { AIChatAgent } from "@cloudflare/ai-chat";
import {
	type StreamTextOnFinishCallback,
	type ToolSet,
	convertToModelMessages,
	extractReasoningMiddleware,
	streamText,
	wrapLanguageModel,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { createJackAI } from "./jack-ai";

interface Env {
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	ASSETS: Fetcher;
	Chat: DurableObjectNamespace;
}

function getAIProvider(env: Env) {
	if (env.__AI_PROXY) {
		const jackAI = createJackAI(env as { __AI_PROXY: Fetcher });
		return createWorkersAI({ binding: jackAI as unknown as Ai });
	}
	if (env.AI) {
		return createWorkersAI({ binding: env.AI });
	}
	throw new Error("No AI binding available");
}

export class Chat extends AIChatAgent<Env> {
	async onChatMessage(onFinish: StreamTextOnFinishCallback<ToolSet>) {
		const provider = getAIProvider(this.env);

		// Fast general-purpose model (recommended default)
		const model = provider(
			"@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<typeof provider>[0],
		);

		// Reasoning model — uncomment for chain-of-thought (shows thinking process):
		// const baseModel = provider(
		//   "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b" as Parameters<typeof provider>[0],
		// );
		// const model = wrapLanguageModel({
		//   model: baseModel,
		//   middleware: extractReasoningMiddleware({ tagName: "think" }),
		// });

		const result = streamText({
			model,
			system:
				"You are a helpful assistant. Be concise and direct. " +
				"Use short paragraphs. Only use markdown formatting when it genuinely helps clarity.",
			messages: await convertToModelMessages(this.messages),
			maxOutputTokens: 2048,
			onFinish,
		});

		return result.toUIMessageStreamResponse();
	}
}
