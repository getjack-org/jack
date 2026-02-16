import { Button } from "@/components/ui/button";
import { MessageSquarePlus, Pencil, Share2 } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Chat from "./chat";

const ADJECTIVES = [
	"Happy",
	"Fuzzy",
	"Cosmic",
	"Crispy",
	"Spicy",
	"Chill",
	"Zesty",
	"Snappy",
	"Bouncy",
	"Groovy",
];
const FRUITS = [
	"Mango",
	"Peach",
	"Lemon",
	"Kiwi",
	"Melon",
	"Berry",
	"Guava",
	"Plum",
	"Fig",
	"Grape",
];

function generateUsername(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
	const fruit = FRUITS[Math.floor(Math.random() * FRUITS.length)];
	const num = Math.floor(Math.random() * 100);
	return `${adj}${fruit}${num}`;
}

function getOrCreateUsername(): string {
	const stored = localStorage.getItem("jack-chat-username");
	if (stored) return stored;
	const name = generateUsername();
	localStorage.setItem("jack-chat-username", name);
	return name;
}

function generateRoomId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function getRoomFromPath(): string | null {
	const match = window.location.pathname.match(/^\/room\/([^/]+)/);
	return match ? match[1] : null;
}

export default function App() {
	const [username, setUsername] = useState(getOrCreateUsername);
	const [isEditingName, setIsEditingName] = useState(false);
	const [nameInput, setNameInput] = useState(username);
	const nameInputRef = useRef<HTMLInputElement>(null);

	const pathRoom = getRoomFromPath();
	const [roomId, setRoomId] = useState<string>(() => pathRoom || generateRoomId());
	const [isSharedRoom, setIsSharedRoom] = useState(!!pathRoom);

	useEffect(() => {
		if (!getRoomFromPath()) {
			window.history.replaceState(null, "", `/room/${roomId}`);
		}
	}, [roomId]);

	useEffect(() => {
		const handlePopState = () => {
			const room = getRoomFromPath();
			if (room) {
				setRoomId(room);
				setIsSharedRoom(true);
			}
		};
		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	const handleNewChat = useCallback(() => {
		const newId = generateRoomId();
		setRoomId(newId);
		setIsSharedRoom(false);
		window.history.pushState(null, "", `/room/${newId}`);
	}, []);

	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	const handleShareRoom = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(window.location.href);
			setCopied(true);
			clearTimeout(copiedTimer.current);
			copiedTimer.current = setTimeout(() => setCopied(false), 2000);
		} catch {
			// Fallback: silently fail if clipboard API is unavailable
		}
	}, []);

	const saveName = () => {
		const trimmed = nameInput.trim();
		if (trimmed) {
			setUsername(trimmed);
			localStorage.setItem("jack-chat-username", trimmed);
		} else {
			setNameInput(username);
		}
		setIsEditingName(false);
	};

	useEffect(() => {
		if (isEditingName && nameInputRef.current) {
			nameInputRef.current.focus();
			nameInputRef.current.select();
		}
	}, [isEditingName]);

	const chatContent = isSharedRoom ? (
		<Suspense
			fallback={
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading conversation...
				</div>
			}
		>
			<Chat key={roomId} roomId={roomId} username={username} loadHistory />
		</Suspense>
	) : (
		<Chat key={roomId} roomId={roomId} username={username} />
	);

	return (
		<div className="flex h-dvh flex-col bg-background text-foreground">
			<header className="flex items-center justify-between border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-3">
					<h1 className="text-base font-semibold tracking-tight">jack-template</h1>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						<span className="hidden sm:inline">as</span>
						{isEditingName ? (
							<input
								ref={nameInputRef}
								value={nameInput}
								onChange={(e) => setNameInput(e.target.value)}
								onBlur={saveName}
								onKeyDown={(e) => {
									if (e.key === "Enter") saveName();
									if (e.key === "Escape") {
										setNameInput(username);
										setIsEditingName(false);
									}
								}}
								className="w-24 rounded border border-input bg-secondary px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
								maxLength={20}
							/>
						) : (
							<button
								type="button"
								onClick={() => {
									setNameInput(username);
									setIsEditingName(true);
								}}
								className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground hover:bg-secondary transition-colors"
							>
								{username}
								<Pencil className="h-3 w-3 text-muted-foreground" />
							</button>
						)}
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={handleShareRoom}>
						<Share2 className="h-4 w-4" />
						{copied ? "Copied!" : "Share"}
					</Button>
					<Button variant="secondary" size="sm" onClick={handleNewChat}>
						<MessageSquarePlus className="h-4 w-4" />
						New Chat
					</Button>
				</div>
			</header>

			<main className="min-h-0 flex-1">{chatContent}</main>
		</div>
	);
}
