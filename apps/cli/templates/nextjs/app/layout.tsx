import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'jack-template',
  description: 'Next.js app built with jack',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
