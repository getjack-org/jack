import {
	ChatContainerContent,
	ChatContainerRoot,
	ChatContainerScrollAnchor,
} from "@/components/prompt-kit/chat-container";
import { TextShimmerLoader } from "@/components/prompt-kit/loader";
import { Message, MessageAvatar, MessageContent } from "@/components/prompt-kit/message";
import { PromptSuggestion } from "@/components/prompt-kit/prompt-suggestion";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/prompt-kit/reasoning";
import { ScrollButton } from "@/components/prompt-kit/scroll-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { ArrowUp, Square } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

const SUGGESTIONS = [
	"What can you help me with?",
	"Write a haiku about coding",
	"Explain quantum computing simply",
	"Tell me a fun fact",
];

interface ChatProps {
	roomId: string;
	username: string;
	loadHistory?: boolean;
}

export default function Chat({ roomId, username, loadHistory }: ChatProps) {
	const agent = useAgent({ agent: "chat", name: roomId });

	const { messages, sendMessage, status, stop } = useAgentChat({
		agent,
		getInitialMessages: loadHistory ? undefined : null,
	});

	const [input, setInput] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const isStreaming = status === "streaming";
	const isLoading = status === "submitted";

	// Auto-resize textarea
	const inputLength = input.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: trigger on input change
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
		}
	}, [inputLength]);

	const send = (text?: string) => {
		const msg = text ?? input.trim();
		if (!msg || isStreaming || isLoading) return;
		sendMessage({ text: msg });
		setInput("");
		if (textareaRef.current) {
			textareaRef.current.style.height = "auto";
		}
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	};

	function getMessageText(message: UIMessage): string {
		return message.parts
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	}

	function getReasoningText(message: UIMessage): string | null {
		const texts: string[] = [];
		for (const part of message.parts) {
			if (part.type === "reasoning") {
				texts.push(part.text);
			}
		}
		return texts.length > 0 ? texts.join("") : null;
	}

	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
	const isWaitingForResponse = isLoading || (isStreaming && lastMessage?.role === "user");

	const userInitials = username.slice(0, 2).toUpperCase();

	return (
		<div className="flex h-full flex-col">
			<ChatContainerRoot className="flex-1">
				<ChatContainerContent className="mx-auto max-w-3xl px-4 py-6">
					{messages.length === 0 && (
						<div className="flex flex-1 flex-col items-center justify-center gap-8">
							<div className="max-w-lg space-y-3 text-center">
								<h2 className="text-2xl font-semibold text-foreground">jack-template</h2>
								<p className="text-sm leading-relaxed text-muted-foreground">
									Real-time AI chat with persistent rooms. Share the link — anyone
									who opens it joins this conversation live. No database, no
									WebSocket server, just code.
								</p>
							</div>
							<div className="flex flex-wrap justify-center gap-2">
								{SUGGESTIONS.map((s) => (
									<PromptSuggestion key={s} onClick={() => send(s)}>
										{s}
									</PromptSuggestion>
								))}
							</div>
						</div>
					)}

					{messages.map((message: UIMessage, index: number) => {
						const isUser = message.role === "user";
						const text = getMessageText(message);
						const reasoning = isUser ? null : getReasoningText(message);
						const isLast = index === messages.length - 1;
						const isStreamingThis = isLast && !isUser && isStreaming;

						if (isUser) {
							return (
								<Message key={message.id} className={cn("mb-4 flex-row-reverse")}>
									<MessageAvatar
										initials={userInitials}
										className="bg-primary text-primary-foreground"
									/>
									<div className="min-w-0 max-w-[75%]">
										<div className="mb-1 text-right text-xs text-muted-foreground">{username}</div>
										<div className="rounded-2xl rounded-tr-md bg-secondary px-4 py-2.5 text-sm">
											{text}
										</div>
									</div>
								</Message>
							);
						}

						return (
							<Message key={message.id} className="mb-4">
								<MessageAvatar initials="AI" className="bg-accent text-accent-foreground" />
								<div className="min-w-0 max-w-[75%] space-y-1">
									<div className="text-xs text-muted-foreground">AI</div>
									{reasoning && (
										<Reasoning isStreaming={isStreamingThis}>
											<ReasoningTrigger>Reasoning</ReasoningTrigger>
											<ReasoningContent markdown className="mt-1">
												{reasoning}
											</ReasoningContent>
										</Reasoning>
									)}
									<MessageContent markdown>{isStreamingThis ? `${text}▍` : text}</MessageContent>
								</div>
							</Message>
						);
					})}

					{isWaitingForResponse && (
						<Message className="mb-4">
							<MessageAvatar initials="AI" className="bg-accent text-accent-foreground" />
							<div className="pt-1">
								<TextShimmerLoader />
							</div>
						</Message>
					)}

					<ChatContainerScrollAnchor />
				</ChatContainerContent>

				<div className="pointer-events-none sticky bottom-4 flex justify-center">
					<ScrollButton className="pointer-events-auto" />
				</div>
			</ChatContainerRoot>

			{/* Input area */}
			<div className="border-t border-border bg-background p-4">
				<div className="mx-auto max-w-3xl">
					<div className="flex items-end gap-2 rounded-2xl border border-input bg-secondary p-2">
						<textarea
							ref={textareaRef}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={onKeyDown}
							placeholder="Type a message..."
							rows={1}
							className="min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none"
						/>
						{isStreaming ? (
							<Button
								size="icon"
								variant="ghost"
								onClick={() => stop()}
								className="h-9 w-9 shrink-0 rounded-xl"
								aria-label="Stop generating"
							>
								<Square className="h-4 w-4" />
							</Button>
						) : (
							<Button
								size="icon"
								onClick={() => send()}
								disabled={!input.trim() || isLoading}
								className="h-9 w-9 shrink-0 rounded-xl"
								aria-label="Send message"
							>
								<ArrowUp className="h-5 w-5" />
							</Button>
						)}
					</div>
					<p className="mt-1.5 text-center text-xs text-muted-foreground/60">
						Shift+Enter for new line
					</p>
				</div>
			</div>
		</div>
	);
}
