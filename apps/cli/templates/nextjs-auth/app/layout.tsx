import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
	title: "jack-template",
	description: "Next.js app with self-hosted authentication",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="en">
			<body className={`${inter.className} min-h-screen bg-gray-50 text-gray-900 antialiased`}>
				{children}
			</body>
		</html>
	);
}
