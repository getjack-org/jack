import { useState } from "react";
import { useShare } from "../hooks/useShare";

interface ShareSheetProps {
	open: boolean;
	onClose: () => void;
	text: string;
	embedUrl?: string;
	title?: string;
	user?: {
		username: string;
		displayName?: string;
		pfpUrl?: string;
	};
}

export function ShareSheet({
	open,
	onClose,
	text,
	embedUrl,
	title = "Share to Warpcast",
	user,
}: ShareSheetProps) {
	const { share } = useShare();
	const [isSharing, setIsSharing] = useState(false);

	if (!open) return null;

	const handleShare = async () => {
		setIsSharing(true);
		try {
			const result = await share({ text, embedUrl });
			if (result.success) {
				onClose();
			}
		} finally {
			setIsSharing(false);
		}
	};

	const handleBackdropClick = (e: React.MouseEvent) => {
		if (e.target === e.currentTarget) {
			onClose();
		}
	};

	// Truncate preview text if too long
	const previewText = text.length > 280 ? text.slice(0, 277) + "..." : text;

	return (
		<div
			className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center sm:items-center"
			onClick={handleBackdropClick}
		>
			<div className="w-full max-w-md bg-zinc-900 rounded-t-2xl sm:rounded-2xl p-4 pb-8 sm:pb-4 animate-slide-up">
				{/* Header */}
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
					<button
						onClick={onClose}
						className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
						aria-label="Close"
					>
						<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</div>

				{/* Preview card */}
				<div className="bg-zinc-800 rounded-xl p-4 mb-4">
					{user && (
						<div className="flex items-center gap-2 mb-3">
							{user.pfpUrl ? (
								<img src={user.pfpUrl} alt="" className="w-8 h-8 rounded-full" />
							) : (
								<div className="w-8 h-8 rounded-full bg-zinc-700" />
							)}
							<div>
								<p className="text-sm font-medium text-zinc-100">
									{user.displayName || user.username}
								</p>
								<p className="text-xs text-zinc-500">@{user.username}</p>
							</div>
						</div>
					)}
					<p className="text-sm text-zinc-300 italic whitespace-pre-wrap">{previewText}</p>
					{embedUrl && (
						<p className="text-xs text-zinc-500 mt-2 truncate">{embedUrl}</p>
					)}
				</div>

				{/* Actions */}
				<div className="flex gap-3">
					<button
						onClick={onClose}
						className="flex-1 py-3 px-4 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm font-medium transition-colors"
					>
						Cancel
					</button>
					<button
						onClick={handleShare}
						disabled={isSharing}
						className="flex-1 py-3 px-4 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
					>
						{isSharing ? (
							<>
								<svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
									<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
									<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
								</svg>
								Sharing...
							</>
						) : (
							<>
								<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
								</svg>
								Share
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
}
