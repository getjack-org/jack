import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Header } from "@/components/header";
import "./globals.css";

export const metadata: Metadata = {
	title: "jack-template",
	description: "Next.js + Clerk auth app built with jack",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<ClerkProvider>
			<html lang="en">
				<body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
					<Header />
					{children}
				</body>
			</html>
		</ClerkProvider>
	);
}
