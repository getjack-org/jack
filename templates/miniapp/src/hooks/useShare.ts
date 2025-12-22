import { sdk } from "@farcaster/miniapp-sdk";
import { useCallback, useMemo } from "react";

const MAX_CAST_LENGTH = 320;

export interface ShareOptions {
	text: string;
	embedUrl?: string;
	channelKey?: string;
}

export interface ShareResult {
	success: boolean;
	castHash?: string;
}

function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 1) + "…";
}

export function useShare() {
	// Check if we're in a miniapp context
	const isMiniApp = useMemo(() => {
		try {
			return typeof sdk !== "undefined" && sdk.context !== undefined;
		} catch {
			return false;
		}
	}, []);

	const share = useCallback(
		async (options: ShareOptions): Promise<ShareResult> => {
			const { embedUrl, channelKey } = options;
			const text = truncateText(options.text, MAX_CAST_LENGTH);

			// Build embeds - SDK expects tuple of 0-2 strings
			const embeds = embedUrl ? [embedUrl] as [string] : undefined;

			if (isMiniApp) {
				try {
					const result = await sdk.actions.composeCast({
						text,
						embeds,
						channelKey,
					});

					// User may cancel the compose
					if (result?.cast) {
						return { success: true, castHash: result.cast.hash };
					}
					return { success: false };
				} catch (error) {
					console.error("Failed to compose cast:", error);
					return { success: false };
				}
			}

			// Fallback: open Farcaster compose URL
			const url = new URL("https://farcaster.xyz/~/compose");
			url.searchParams.set("text", text);
			if (embedUrl) {
				url.searchParams.append("embeds[]", embedUrl);
			}
			if (channelKey) {
				url.searchParams.set("channelKey", channelKey);
			}

			window.open(url.toString(), "_blank");
			return { success: true };
		},
		[isMiniApp],
	);

	return { share, isMiniApp };
}
