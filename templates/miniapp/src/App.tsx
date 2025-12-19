import { sdk } from "@farcaster/miniapp-sdk";
import { useEffect, useState } from "react";
import { type GuestbookEntry, useAddGuestbookEntry, useGuestbook } from "./hooks/useGuestbook";

interface Notification {
	type: string;
	most_recent_timestamp: string;
	seen: boolean;
	cast?: {
		text: string;
		hash: string;
		author: {
			username: string;
			display_name: string;
			pfp_url: string;
		};
	};
	follows?: Array<{
		user: {
			username: string;
			display_name: string;
			pfp_url: string;
		};
	}>;
	reactions?: Array<{
		user: {
			username: string;
			display_name: string;
			pfp_url: string;
		};
	}>;
	count?: number;
}

interface NotificationsResponse {
	notifications: Notification[];
	unseen_notifications_count: number;
}

export default function App() {
	const [isReady, setIsReady] = useState(false);
	const [context, setContext] = useState<any>(null);
	const [activeTab, setActiveTab] = useState<"notifications" | "guestbook">("guestbook");

	// Notifications state
	const [notifications, setNotifications] = useState<Notification[]>([]);
	const [unseenCount, setUnseenCount] = useState(0);
	const [notifLoading, setNotifLoading] = useState(false);
	const [notifError, setNotifError] = useState<string | null>(null);

	// Guestbook hooks
	const {
		data: guestbookEntries,
		isLoading: guestbookLoading,
		error: guestbookError,
	} = useGuestbook();
	const addEntry = useAddGuestbookEntry();
	const [newMessage, setNewMessage] = useState("");

	useEffect(() => {
		const init = async () => {
			const ctx = await sdk.context;
			setContext(ctx);
			sdk.actions.ready();
			setIsReady(true);
		};
		init();
	}, []);

	const fetchNotifications = async (fid: number) => {
		setNotifLoading(true);
		setNotifError(null);
		try {
			const response = await fetch(`/api/notifications?fid=${fid}`);
			if (!response.ok) throw new Error("Failed to fetch notifications");
			const data: NotificationsResponse = await response.json();
			setNotifications(data.notifications || []);
			setUnseenCount(data.unseen_notifications_count || 0);
		} catch (err) {
			setNotifError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setNotifLoading(false);
		}
	};

	const handleAddGuestbookEntry = async () => {
		if (!context?.user || !newMessage.trim()) return;

		try {
			await addEntry.mutateAsync({
				fid: context.user.fid,
				username: context.user.username,
				displayName: context.user.displayName,
				pfpUrl: context.user.pfpUrl,
				message: newMessage.trim(),
			});
			setNewMessage("");
		} catch (err) {
			console.error("Failed to add entry:", err);
		}
	};

	const formatTime = (timestamp: string) => {
		const diff = Date.now() - new Date(timestamp).getTime();
		const mins = Math.floor(diff / 60000);
		const hrs = Math.floor(mins / 60);
		const days = Math.floor(hrs / 24);
		if (days > 0) return `${days}d`;
		if (hrs > 0) return `${hrs}h`;
		if (mins > 0) return `${mins}m`;
		return "now";
	};

	const getNotificationTitle = (n: Notification) => {
		const count = n.count || 1;
		switch (n.type) {
			case "follows": {
				const who = n.follows?.[0]?.user?.display_name || "Someone";
				const others = count > 1 ? ` +${count - 1}` : "";
				return `${who}${others} followed you`;
			}
			case "likes": {
				const who = n.reactions?.[0]?.user?.display_name || "Someone";
				const others = count > 1 ? ` +${count - 1}` : "";
				return `${who}${others} liked`;
			}
			case "recasts": {
				const who = n.reactions?.[0]?.user?.display_name || "Someone";
				const others = count > 1 ? ` +${count - 1}` : "";
				return `${who}${others} recasted`;
			}
			case "mention":
				return `${n.cast?.author?.display_name || "Someone"} mentioned you`;
			case "reply":
				return `${n.cast?.author?.display_name || "Someone"} replied`;
			default:
				return n.type;
		}
	};

	if (!isReady) {
		return (
			<div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
				<p className="text-zinc-500">Loading...</p>
			</div>
		);
	}

	return (
		<div className="min-h-screen bg-zinc-950 text-zinc-100">
			<div className="max-w-md mx-auto p-4 flex flex-col gap-4">
				<h1 className="text-xl font-semibold">jack-template</h1>

				{/* User card */}
				{context?.user && (
					<div className="flex items-center gap-3 p-3 bg-zinc-900 rounded-xl">
						<img
							src={context.user.pfpUrl}
							alt={context.user.displayName}
							className="w-10 h-10 rounded-full"
						/>
						<div>
							<p className="font-medium text-sm">{context.user.displayName}</p>
							<p className="text-zinc-500 text-xs">@{context.user.username}</p>
						</div>
					</div>
				)}

				{/* Tabs */}
				<div className="flex gap-1 bg-zinc-900 p-1 rounded-lg">
					<button
						onClick={() => setActiveTab("guestbook")}
						className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
							activeTab === "guestbook"
								? "bg-violet-600 text-white"
								: "text-zinc-400 hover:text-zinc-200"
						}`}
					>
						Guestbook
					</button>
					<button
						onClick={() => {
							setActiveTab("notifications");
							if (context?.user?.fid && notifications.length === 0) {
								fetchNotifications(context.user.fid);
							}
						}}
						className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
							activeTab === "notifications"
								? "bg-violet-600 text-white"
								: "text-zinc-400 hover:text-zinc-200"
						}`}
					>
						Notifications
						{unseenCount > 0 && (
							<span className="ml-1.5 bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full">
								{unseenCount}
							</span>
						)}
					</button>
				</div>

				{/* Guestbook Tab */}
				{activeTab === "guestbook" && (
					<div className="flex flex-col gap-3">
						{/* Add entry form */}
						<div className="flex gap-2">
							<input
								type="text"
								value={newMessage}
								onChange={(e) => setNewMessage(e.target.value)}
								onKeyDown={(e) => e.key === "Enter" && handleAddGuestbookEntry()}
								placeholder="Sign the guestbook..."
								maxLength={140}
								className="flex-1 px-3 py-2 bg-zinc-900 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
							/>
							<button
								onClick={handleAddGuestbookEntry}
								disabled={!newMessage.trim() || addEntry.isPending}
								className="px-4 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
							>
								{addEntry.isPending ? "..." : "Sign"}
							</button>
						</div>

						{/* Error */}
						{addEntry.isError && <p className="text-red-400 text-xs">{addEntry.error.message}</p>}

						{/* Entries */}
						{guestbookLoading && <p className="text-zinc-500 text-sm">Loading...</p>}
						{guestbookError && <p className="text-red-400 text-sm">Failed to load</p>}

						<div className="flex flex-col gap-2">
							{guestbookEntries?.map((entry: GuestbookEntry) => (
								<div key={entry.id} className="p-3 bg-zinc-900 rounded-xl">
									<div className="flex gap-2">
										{entry.pfp_url ? (
											<img src={entry.pfp_url} alt="" className="w-8 h-8 rounded-full shrink-0" />
										) : (
											<div className="w-8 h-8 rounded-full bg-zinc-800 shrink-0" />
										)}
										<div className="flex-1 min-w-0">
											<div className="flex items-center justify-between gap-2">
												<p className="text-sm font-medium truncate">
													{entry.display_name || `@${entry.username}`}
												</p>
												<span className="text-zinc-500 text-xs shrink-0">
													{formatTime(entry.created_at)}
												</span>
											</div>
											<p className="text-sm text-zinc-300 mt-0.5 break-words">{entry.message}</p>
										</div>
									</div>
								</div>
							))}

							{!guestbookLoading && !guestbookError && guestbookEntries?.length === 0 && (
								<p className="text-zinc-600 text-sm text-center py-8">
									Be the first to sign the guestbook!
								</p>
							)}
						</div>
					</div>
				)}

				{/* Notifications Tab */}
				{activeTab === "notifications" && (
					<div className="flex flex-col gap-3">
						{notifLoading && <p className="text-zinc-500 text-sm">Loading...</p>}
						{notifError && <p className="text-red-400 text-sm">{notifError}</p>}

						<div className="flex flex-col gap-2">
							{notifications.map((n, i) => (
								<div
									key={i}
									className={`p-3 rounded-xl ${
										n.seen ? "bg-zinc-900" : "bg-zinc-900/80 ring-1 ring-violet-500/30"
									}`}
								>
									<div className="flex items-start justify-between gap-2">
										<p className="text-sm">{getNotificationTitle(n)}</p>
										<span className="text-zinc-500 text-xs shrink-0">
											{formatTime(n.most_recent_timestamp)}
										</span>
									</div>
									{n.cast?.text && (
										<p className="text-xs text-zinc-400 mt-1 line-clamp-2">{n.cast.text}</p>
									)}
								</div>
							))}
						</div>

						{!notifLoading && !notifError && notifications.length === 0 && (
							<p className="text-zinc-600 text-sm text-center py-8">No notifications</p>
						)}

						<button
							onClick={() => context?.user?.fid && fetchNotifications(context.user.fid)}
							disabled={notifLoading}
							className="w-full py-2 px-4 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 rounded-lg text-sm font-medium transition-colors"
						>
							Refresh
						</button>
					</div>
				)}

				{/* Close button */}
				<button
					onClick={() => sdk.actions.close()}
					className="w-full py-2 px-4 bg-zinc-800 hover:bg-zinc-700 rounded-lg text-sm font-medium transition-colors"
				>
					Close
				</button>
			</div>
		</div>
	);
}
