import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000, // Data fresh for 30s
			gcTime: 5 * 60 * 1000, // Keep in cache 5min
			retry: 1, // Only retry once
			refetchOnWindowFocus: false, // Don't spam on tab focus
		},
	},
});
