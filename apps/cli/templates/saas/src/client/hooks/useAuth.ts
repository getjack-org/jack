import { authClient } from "../lib/auth-client";

export function useAuth() {
	const { data: session, isPending, error } = authClient.useSession();

	return {
		user: session?.user ?? null,
		session: session?.session ?? null,
		isLoading: isPending,
		isAuthenticated: !!session?.user,
		error,
		signOut: () => authClient.signOut(),
	};
}
