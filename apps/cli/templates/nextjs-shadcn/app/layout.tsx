import { TooltipProvider } from "@/components/ui/tooltip";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "jack-template",
	description: "Next.js + shadcn/ui app built with jack",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
			<body className="font-sans antialiased">
				<TooltipProvider>{children}</TooltipProvider>
			</body>
		</html>
	);
}
