import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface GuestbookEntry {
	id: number;
	fid: number;
	username: string;
	display_name: string | null;
	pfp_url: string | null;
	message: string;
	created_at: string;
}

// Fetch guestbook entries
export function useGuestbook() {
	return useQuery({
		queryKey: ["guestbook"],
		queryFn: async () => {
			const res = await api.api.guestbook.$get();
			if (!res.ok) throw new Error("Failed to fetch guestbook");
			const data = await res.json();
			return (data as { entries: GuestbookEntry[] }).entries;
		},
	});
}

// Add a new guestbook entry
export function useAddGuestbookEntry() {
	const qc = useQueryClient();

	return useMutation<
		{ entry: GuestbookEntry },
		Error,
		{
			fid: number;
			username: string;
			displayName?: string;
			pfpUrl?: string;
			message: string;
		}
	>({
		mutationFn: async (entry: {
			fid: number;
			username: string;
			displayName?: string;
			pfpUrl?: string;
			message: string;
		}) => {
			const res = await api.api.guestbook.$post({ json: entry });
			if (!res.ok) {
				const error = await res.json();
				throw new Error((error as { error: string }).error || "Failed to add entry");
			}
			return res.json();
		},
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ["guestbook"] });
		},
	});
}
