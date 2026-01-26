import { type ReactNode, useEffect } from "react";
import { authClient } from "../lib/auth-client";

type Route =
	| "/"
	| "/login"
	| "/signup"
	| "/pricing"
	| "/dashboard"
	| "/forgot-password"
	| "/reset-password";

interface ProtectedRouteProps {
	children: ReactNode;
	navigate: (path: Route) => void;
}

export function ProtectedRoute({ children, navigate }: ProtectedRouteProps) {
	const { data: session, isPending } = authClient.useSession();

	useEffect(() => {
		if (!isPending && !session) {
			navigate("/login" as Route);
		}
	}, [session, isPending, navigate]);

	if (isPending) {
		return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
	}

	if (!session) {
		return null;
	}

	return <>{children}</>;
}
