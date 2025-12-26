import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";

interface GenerateResult {
	result: string;
	provider: "openai" | "workers-ai";
}

export function useAI() {
	const mutation = useMutation<GenerateResult, Error, { prompt: string }>({
		mutationFn: async ({ prompt }: { prompt: string }): Promise<GenerateResult> => {
			const res = await api.api.ai.generate.$post({
				json: { prompt },
			});

			if (!res.ok) {
				const error = await res.json().catch(() => ({ error: "AI request failed" }));
				throw new Error((error as { error: string }).error || "AI request failed");
			}

			return res.json() as Promise<GenerateResult>;
		},
	});

	const generate = async (prompt: string) => {
		return mutation.mutateAsync({ prompt });
	};

	return {
		generate,
		isLoading: mutation.isPending,
		error: mutation.error?.message ?? null,
		reset: mutation.reset,
	};
}
