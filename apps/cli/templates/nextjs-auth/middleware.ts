import { type NextRequest, NextResponse } from "next/server";

const protectedPaths = ["/dashboard"];

export function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	const isProtected = protectedPaths.some(
		(path) => pathname === path || pathname.startsWith(`${path}/`),
	);

	if (!isProtected) {
		return NextResponse.next();
	}

	// Edge-safe session check: only inspect the cookie, do not call auth.api.getSession()
	// because that requires Node.js APIs (perf_hooks) unavailable in edge middleware.
	const sessionCookie =
		request.cookies.get("better-auth.session_token") ??
		request.cookies.get("__Secure-better-auth.session_token");

	if (!sessionCookie?.value) {
		const loginUrl = new URL("/login", request.url);
		loginUrl.searchParams.set("callbackUrl", pathname);
		return NextResponse.redirect(loginUrl);
	}

	return NextResponse.next();
}

export const config = {
	matcher: ["/dashboard/:path*"],
};
