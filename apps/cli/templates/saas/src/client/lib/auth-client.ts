import { createAuthClient } from "better-auth/react";
import { stripeClient } from "@better-auth/stripe/client";

export const authClient = createAuthClient({
	baseURL: window.location.origin,
	plugins: [stripeClient({ subscription: true })],
});
