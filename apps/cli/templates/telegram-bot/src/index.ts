import { Bot, webhookCallback } from "grammy";
import { createJackAI } from "./jack-ai";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_MESSAGE_LENGTH = 4000;

interface Env {
	BOT_TOKEN: string;
	WEBHOOK_SECRET: string;
	AI?: Ai;
	__AI_PROXY?: Fetcher;
	__JACK_PROJECT_ID?: string;
	__JACK_ORG_ID?: string;
}

type AIRunner = {
	run: (model: string, inputs: unknown) => Promise<unknown>;
};

function getAI(env: Env): AIRunner {
	if (env.__AI_PROXY && env.__JACK_PROJECT_ID && env.__JACK_ORG_ID) {
		return createJackAI(
			env as Required<Pick<Env, "__AI_PROXY" | "__JACK_PROJECT_ID" | "__JACK_ORG_ID">>,
		);
	}
	if (env.AI) return env.AI as unknown as AIRunner;
	throw new Error("No AI binding available");
}

async function askAI(env: Env, question: string): Promise<string> {
	const ai = getAI(env);
	const result = (await ai.run(MODEL, {
		messages: [
			{
				role: "system",
				content:
					"You are a helpful Telegram bot powered by getjack.org. Keep answers concise and clear. Use plain text, not markdown.",
			},
			{ role: "user", content: question },
		],
	})) as { response?: string };

	return result.response ?? "Sorry, I couldn't generate a response.";
}

async function sendChunked(
	ctx: { reply: (text: string) => Promise<unknown> },
	text: string,
): Promise<void> {
	if (text.length <= MAX_MESSAGE_LENGTH) {
		await ctx.reply(text);
		return;
	}

	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= MAX_MESSAGE_LENGTH) {
			chunks.push(remaining);
			break;
		}
		let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
		if (splitAt < MAX_MESSAGE_LENGTH / 2) {
			splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
		}
		if (splitAt < MAX_MESSAGE_LENGTH / 2) {
			splitAt = MAX_MESSAGE_LENGTH;
		}
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}

	for (const chunk of chunks) {
		await ctx.reply(chunk);
	}
}

async function getBotUsername(env: Env): Promise<string | null> {
	try {
		const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
		const data = (await res.json()) as {
			ok: boolean;
			result?: { username?: string };
		};
		return data.ok ? (data.result?.username ?? null) : null;
	} catch {
		return null;
	}
}

async function registerWebhook(env: Env, url: string): Promise<Response> {
	const [webhookRes, username] = await Promise.all([
		fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url,
				secret_token: env.WEBHOOK_SECRET,
				allowed_updates: ["message", "callback_query"],
			}),
		}),
		getBotUsername(env),
	]);
	const data = (await webhookRes.json()) as {
		ok: boolean;
		description?: string;
	};
	const botUrl = username ? `https://t.me/${username}` : null;
	if (data.ok) {
		return new Response(JSON.stringify({ registered: true, url, botUrl, username }), {
			headers: { "Content-Type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ registered: false, error: data.description }), {
		status: 500,
		headers: { "Content-Type": "application/json" },
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/register-webhook") {
			return registerWebhook(env, url.origin);
		}

		if (url.pathname === "/bot-link") {
			const username = await getBotUsername(env);
			if (username) {
				return new Response(`https://t.me/${username}`, {
					headers: { "Content-Type": "text/plain" },
				});
			}
			return new Response("", { status: 404 });
		}

		if (request.method !== "POST") {
			const username = await getBotUsername(env);
			const botLink = username
				? `<p><a href="https://t.me/${username}">Open @${username} in Telegram</a> and send <code>/start</code></p>`
				: `<p>Open your bot in Telegram and send <code>/start</code></p>`;
			return new Response(
				`<!DOCTYPE html><html><head><meta charset="utf-8"><title>jack-template</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 20px}
a{color:#0088cc}code{background:#f0f0f0;padding:2px 6px;border-radius:3px}</style></head>
<body><h2>jack-template</h2>${botLink}
<p>Commands: <code>/start</code> <code>/help</code> <code>/ask</code> <code>/status</code></p></body></html>`,
				{ headers: { "Content-Type": "text/html;charset=utf-8" } },
			);
		}

		const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
		if (secret !== env.WEBHOOK_SECRET) {
			return new Response("Unauthorized", { status: 403 });
		}

		const bot = new Bot(env.BOT_TOKEN);

		bot.command("start", async (ctx) => {
			await ctx.reply(
				[
					"Hey! I'm an AI-powered bot.",
					"",
					"Commands:",
					"/ask <question> - Ask me anything",
					"/status - Bot info",
					"/help - Show this message",
					"",
					"You can also reply to any of my messages to continue the conversation.",
				].join("\n"),
			);
		});

		bot.command("help", async (ctx) => {
			await ctx.reply(
				[
					"Available commands:",
					"",
					"/ask <question> - Ask the AI a question",
					"/status - Show bot status and info",
					"/help - Show this help message",
					"",
					"Tip: Reply to any of my messages to ask a follow-up question.",
				].join("\n"),
			);
		});

		bot.command("status", async (ctx) => {
			const cf = (request as Request & { cf?: Record<string, string> }).cf;
			const region = cf?.colo ?? "unknown";
			const country = cf?.country ?? "unknown";

			await ctx.reply(
				[
					"Bot Status",
					"",
					`Region: ${region} (${country})`,
					`Time: ${new Date().toISOString()}`,
					`Runtime: Edge`,
					`AI Model: ${MODEL}`,
				].join("\n"),
			);
		});

		bot.command("ask", async (ctx) => {
			const question = ctx.match;
			if (!question) {
				await ctx.reply(
					"Usage: /ask <your question>\n\nExample: /ask What is the meaning of life?",
				);
				return;
			}

			const answer = await askAI(env, question);
			await sendChunked(ctx, answer);
		});

		bot.on("message:text", async (ctx) => {
			// In private chats, respond to every message
			if (ctx.chat.type === "private") {
				const answer = await askAI(env, ctx.message.text);
				await sendChunked(ctx, answer);
				return;
			}
			// In groups, only respond when replying to bot's message
			const replyTo = ctx.message.reply_to_message;
			if (replyTo?.from?.id === bot.botInfo.id) {
				const answer = await askAI(env, ctx.message.text);
				await sendChunked(ctx, answer);
			}
		});

		return webhookCallback(bot, "cloudflare-mod")(request);
	},
};
