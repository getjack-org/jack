import { createWorkersAiChat } from "@cloudflare/tanstack-ai/adapters/workers-ai";
import { chat, toServerSentEventsResponse } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { Hono } from "hono";
import { createJackAI } from "./jack-ai";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
	"You are a helpful AI assistant powered by jack. Be concise, friendly, and helpful. Use markdown for formatting when appropriate.";

interface Env {
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	__JACK_PROJECT_ID?: string;
	__JACK_ORG_ID?: string;
	ASSETS: Fetcher;
	DB: D1Database;
}

function getAI(env: Env) {
	if (env.__AI_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
		const proxy = createJackAI(
			env as Required<Pick<Env, "__AI_PROXY" | "__JACK_PROJECT_ID" | "__JACK_ORG_ID">>,
		);
		// Add gateway stub so @cloudflare/tanstack-ai recognizes the binding
		return Object.assign(proxy, { gateway: () => proxy });
	}
	if (env.AI) return env.AI;
	throw new Error("No AI binding available");
}

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);
	if (!entry || now >= entry.resetAt) {
		rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
		return true;
	}
	if (entry.count >= RATE_LIMIT) return false;
	entry.count++;
	return true;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

app.post("/api/chat/new", async (c) => {
	const id = crypto.randomUUID();
	await c.env.DB.prepare("INSERT INTO chats (id) VALUES (?)").bind(id).run();
	return c.json({ id });
});

app.get("/api/chat/:id", async (c) => {
	const chatId = c.req.param("id");
	const { results } = await c.env.DB.prepare(
		"SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC",
	)
		.bind(chatId)
		.all();
	return c.json({ messages: results || [] });
});

app.post("/api/chat", async (c) => {
	const ip = c.req.header("cf-connecting-ip") || "unknown";
	if (!checkRateLimit(ip)) {
		return c.json({ error: "Too many requests. Please wait a moment." }, 429);
	}

	const body = await c.req.json<{
		messages: ModelMessage[];
		data?: { chatId?: string };
	}>();

	const { messages } = body;
	const chatId = body.data?.chatId;

	if (!messages || !Array.isArray(messages)) {
		return c.json({ error: "Invalid request." }, 400);
	}

	// Save user message
	const lastUserMsg = messages.findLast((m: ModelMessage) => m.role === "user");
	if (chatId && lastUserMsg) {
		const content = extractText(lastUserMsg.content);
		if (content) {
			await c.env.DB.prepare(
				"INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)",
			)
				.bind(crypto.randomUUID(), chatId, "user", content)
				.run();
		}
	}

	const ai = getAI(c.env);
	// biome-ignore lint/suspicious/noExplicitAny: binding + model type mismatch between jack proxy and CF types
	const adapter = createWorkersAiChat(MODEL as any, { binding: ai as any });

	const stream = chat({
		adapter,
		messages,
		systemPrompts: [SYSTEM_PROMPT],
	});

	if (!chatId) {
		return toServerSentEventsResponse(stream);
	}

	// Wrap stream to persist the assistant response
	const db = c.env.DB;
	async function* withPersistence(): AsyncIterable<StreamChunk> {
		let fullText = "";
		for await (const chunk of stream) {
			if (
				chunk.type === "TEXT_MESSAGE_CONTENT" &&
				"content" in chunk &&
				typeof chunk.content === "string"
			) {
				fullText = chunk.content;
			}
			yield chunk;
		}
		if (fullText) {
			await db
				.prepare("INSERT INTO messages (id, chat_id, role, content) VALUES (?, ?, ?, ?)")
				.bind(crypto.randomUUID(), chatId, "assistant", fullText)
				.run();
		}
	}

	return toServerSentEventsResponse(withPersistence());
});

function extractText(content: ModelMessage["content"] | string | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p): p is { type: "text"; content: string } => p.type === "text")
			.map((p) => p.content)
			.join("");
	}
	return "";
}

app.get("*", async (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
