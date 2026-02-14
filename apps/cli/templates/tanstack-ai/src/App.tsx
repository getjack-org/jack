import type { UIMessage } from "@tanstack/ai-client";
import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

interface DbMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	created_at: number;
}

function toUIMessages(rows: DbMessage[]): UIMessage[] {
	return rows.map((m) => ({
		id: m.id,
		role: m.role,
		parts: [{ type: "text" as const, content: m.content }],
	}));
}

export default function App() {
	const [chatId, setChatId] = useState<string | null>(null);
	const [loaded, setLoaded] = useState<UIMessage[]>([]);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		(async () => {
			const stored = localStorage.getItem("chatId");
			if (stored) {
				try {
					const res = await fetch(`/api/chat/${stored}`);
					const data = await res.json<{ messages: DbMessage[] }>();
					if (data.messages?.length) {
						setChatId(stored);
						setLoaded(toUIMessages(data.messages));
						setReady(true);
						return;
					}
				} catch {
					/* ignore */
				}
			}
			const res = await fetch("/api/chat/new", { method: "POST" });
			const { id } = await res.json<{ id: string }>();
			localStorage.setItem("chatId", id);
			setChatId(id);
			setReady(true);
		})();
	}, []);

	if (!ready || !chatId) {
		return (
			<div className="flex h-full items-center justify-center bg-gray-50">
				<div className="text-gray-400 animate-pulse">Loading...</div>
			</div>
		);
	}

	return <ChatView key={chatId} chatId={chatId} initialMessages={loaded} />;
}

function ChatView({ chatId, initialMessages }: { chatId: string; initialMessages: UIMessage[] }) {
	const { messages, sendMessage, isLoading, error } = useChat({
		connection: fetchServerSentEvents("/api/chat", {
			body: { chatId },
		}),
		initialMessages,
	});

	const [input, setInput] = useState("");
	const bottomRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const messageCount = messages.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messageCount]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = useCallback(() => {
		const text = input.trim();
		if (!text || isLoading) return;
		setInput("");
		sendMessage(text);
	}, [input, isLoading, sendMessage]);

	const handleNewChat = useCallback(async () => {
		const res = await fetch("/api/chat/new", { method: "POST" });
		const { id } = await res.json<{ id: string }>();
		localStorage.setItem("chatId", id);
		window.location.reload();
	}, []);

	return (
		<div className="flex h-full flex-col bg-gray-50">
			<header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 shadow-sm">
				<div className="flex items-center gap-3">
					<h1 className="text-lg font-semibold text-gray-900">jack-template</h1>
					<span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
						TanStack AI
					</span>
				</div>
				<div className="flex items-center gap-3">
					<span className="hidden text-xs text-gray-400 sm:inline">{MODEL}</span>
					<button
						type="button"
						onClick={handleNewChat}
						className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50"
					>
						New Chat
					</button>
				</div>
			</header>

			<main className="flex-1 overflow-y-auto">
				{messages.length === 0 ? (
					<EmptyState />
				) : (
					<div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
						{messages.map((msg) => (
							<MessageBubble key={msg.id} message={msg} />
						))}
						{error && (
							<div className="mx-auto max-w-2xl rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
								{error.message}
							</div>
						)}
						<div ref={bottomRef} />
					</div>
				)}
			</main>

			<footer className="border-t border-gray-200 bg-white px-4 py-3">
				<div className="mx-auto flex max-w-3xl items-end gap-2">
					<textarea
						ref={inputRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								handleSubmit();
							}
						}}
						placeholder="Type a message..."
						rows={1}
						className="flex-1 resize-none rounded-xl border border-gray-300 px-4 py-3 text-sm transition focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
					/>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={isLoading || !input.trim()}
						className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
					>
						{isLoading ? (
							<span className="inline-flex items-center gap-1">
								<LoadingDots />
							</span>
						) : (
							"Send"
						)}
					</button>
				</div>
				<p className="mx-auto mt-2 max-w-3xl text-center text-xs text-gray-400">
					Powered by TanStack AI &middot; Streaming via SSE &middot; Chat history saved to D1
				</p>
			</footer>
		</div>
	);
}

function MessageBubble({ message }: { message: UIMessage }) {
	const isUser = message.role === "user";
	const text = message.parts
		.filter((p): p is { type: "text"; content: string } => p.type === "text")
		.map((p) => p.content)
		.join("");

	if (!text) return null;

	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
					isUser
						? "bg-blue-600 text-white rounded-br-md"
						: "bg-white text-gray-800 border border-gray-200 rounded-bl-md shadow-sm"
				}`}
			>
				{isUser ? text : <RenderContent content={text} />}
			</div>
		</div>
	);
}

function RenderContent({ content }: { content: string }) {
	const blocks = parseBlocks(content);
	if (blocks.length === 1 && blocks[0].type === "text") {
		return <>{renderInline(blocks[0].content)}</>;
	}
	return (
		<div className="space-y-2">
			{blocks.map((block) => (
				<RenderBlock key={block.key} block={block} />
			))}
		</div>
	);
}

interface Block {
	key: string;
	type: "text" | "code" | "ul" | "ol";
	content: string;
	items?: string[];
	lang?: string;
}

function parseBlocks(content: string): Block[] {
	const blocks: Block[] = [];
	const parts = content.split(/(```[\s\S]*?```)/g);
	let idx = 0;
	for (const part of parts) {
		if (part.startsWith("```")) {
			const lines = part.split("\n");
			const lang = lines[0].slice(3).trim();
			const code = lines.slice(1, lines[lines.length - 1] === "```" ? -1 : undefined).join("\n");
			blocks.push({ key: `b${idx++}`, type: "code", content: code, lang });
		} else if (part.trim()) {
			const paragraphs = part.split("\n\n").filter((p) => p.trim());
			for (const p of paragraphs) {
				if (/^[-*]\s/.test(p)) {
					blocks.push({
						key: `b${idx++}`,
						type: "ul",
						content: p,
						items: p
							.split("\n")
							.filter(Boolean)
							.map((l) => l.replace(/^[-*]\s/, "")),
					});
				} else if (/^\d+\.\s/.test(p)) {
					blocks.push({
						key: `b${idx++}`,
						type: "ol",
						content: p,
						items: p
							.split("\n")
							.filter(Boolean)
							.map((l) => l.replace(/^\d+\.\s/, "")),
					});
				} else {
					blocks.push({ key: `b${idx++}`, type: "text", content: p });
				}
			}
		}
	}
	return blocks;
}

function RenderBlock({ block }: { block: Block }) {
	switch (block.type) {
		case "code":
			return (
				<pre className="bg-gray-900 text-gray-200 rounded-lg px-4 py-3 overflow-x-auto text-xs">
					<code>{block.content}</code>
				</pre>
			);
		case "ul":
			return (
				<ul className="list-disc pl-5 space-y-0.5">
					{block.items?.map((item) => (
						<li key={item}>{renderInline(item)}</li>
					))}
				</ul>
			);
		case "ol":
			return (
				<ol className="list-decimal pl-5 space-y-0.5">
					{block.items?.map((item) => (
						<li key={item}>{renderInline(item)}</li>
					))}
				</ol>
			);
		default:
			return <p>{renderInline(block.content)}</p>;
	}
}

function renderInline(text: string): ReactNode[] {
	// Split by inline patterns: **bold**, *italic*, `code`, [link](url)
	const parts: ReactNode[] = [];
	const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
	let lastIndex = 0;
	let key = 0;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop
	while ((match = pattern.exec(text)) !== null) {
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}
		const token = match[0];
		if (token.startsWith("**")) {
			parts.push(<strong key={`i${key++}`}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("*")) {
			parts.push(<em key={`i${key++}`}>{token.slice(1, -1)}</em>);
		} else if (token.startsWith("`")) {
			parts.push(
				<code key={`i${key++}`} className="bg-gray-100 text-gray-800 px-1 py-0.5 rounded text-xs">
					{token.slice(1, -1)}
				</code>,
			);
		} else if (token.startsWith("[")) {
			const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
			if (linkMatch) {
				parts.push(
					<a
						key={`i${key++}`}
						href={linkMatch[2]}
						className="text-blue-600 underline"
						target="_blank"
						rel="noopener noreferrer"
					>
						{linkMatch[1]}
					</a>,
				);
			}
		}
		lastIndex = match.index + token.length;
	}
	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}
	return parts.length > 0 ? parts : [text];
}

function EmptyState() {
	return (
		<div className="flex h-full flex-col items-center justify-center px-4 text-center">
			<div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-2xl text-white shadow-lg">
				AI
			</div>
			<h2 className="text-xl font-semibold text-gray-800">AI Chat</h2>
			<p className="mt-2 max-w-md text-sm text-gray-500">
				Full-stack AI chat built with TanStack AI, streaming responses via Server-Sent Events, and
				conversation history persisted in D1.
			</p>
			<div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
				{[
					"What can you help me with?",
					"Explain how streaming works",
					"Write a haiku about coding",
					"What is TanStack AI?",
				].map((q) => (
					<div
						key={q}
						className="cursor-default rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-left text-sm text-gray-600 shadow-sm transition hover:border-gray-300 hover:shadow"
					>
						{q}
					</div>
				))}
			</div>
		</div>
	);
}

function LoadingDots() {
	return (
		<span className="inline-flex gap-1">
			<span className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:0ms]" />
			<span className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:150ms]" />
			<span className="h-1.5 w-1.5 rounded-full bg-white/70 animate-bounce [animation-delay:300ms]" />
		</span>
	);
}
