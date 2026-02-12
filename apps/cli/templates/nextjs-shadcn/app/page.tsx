import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
	ArrowRight,
	Database,
	LayoutDashboard,
	LogIn,
	Palette,
	PanelLeft,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { ComponentShowcase } from "./showcase";

export default function Home() {
	return (
		<div className="min-h-screen bg-background">
			<header className="border-b">
				<div className="container mx-auto flex h-14 items-center justify-between px-6">
					<div className="flex items-center gap-2 font-semibold">
						<div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs">
							J
						</div>
						jack-template
					</div>
					<nav className="flex items-center gap-1">
						<Button variant="ghost" size="sm" asChild>
							<Link href="/dashboard">Dashboard</Link>
						</Button>
						<Button variant="ghost" size="sm" asChild>
							<Link href="/login">Login</Link>
						</Button>
					</nav>
				</div>
			</header>

			<main className="container mx-auto px-6 py-16">
				<section className="mx-auto max-w-2xl text-center">
					<Badge variant="secondary" className="mb-4">
						Next.js + shadcn/ui + D1
					</Badge>
					<h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
						Start building with
						<br />
						<span className="text-muted-foreground">57 components</span> ready to go
					</h1>
					<p className="mt-4 text-lg text-muted-foreground">
						All shadcn/ui components pre-installed. D1 database included. Just ship it.
					</p>
					<div className="mt-8 flex items-center justify-center gap-3">
						<Button size="lg" asChild>
							<Link href="/dashboard">
								View Dashboard
								<ArrowRight className="ml-2 size-4" />
							</Link>
						</Button>
						<Button size="lg" variant="outline" asChild>
							<Link href="/login">Login Page</Link>
						</Button>
					</div>
				</section>

				<Separator className="my-16" />

				<section className="grid gap-4 md:grid-cols-3">
					<Link href="/dashboard" className="group">
						<Card className="h-full transition-shadow group-hover:shadow-lg">
							<CardHeader>
								<div className="flex items-center gap-3">
									<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
										<LayoutDashboard className="size-5 text-primary" />
									</div>
									<div>
										<CardTitle className="text-base">Dashboard</CardTitle>
										<CardDescription>Sidebar, charts, data table</CardDescription>
									</div>
								</div>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									Full dashboard layout with collapsible sidebar, interactive charts, and sortable
									data table.
								</p>
							</CardContent>
						</Card>
					</Link>

					<Link href="/login" className="group">
						<Card className="h-full transition-shadow group-hover:shadow-lg">
							<CardHeader>
								<div className="flex items-center gap-3">
									<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
										<LogIn className="size-5 text-primary" />
									</div>
									<div>
										<CardTitle className="text-base">Login</CardTitle>
										<CardDescription>Auth form with socials</CardDescription>
									</div>
								</div>
							</CardHeader>
							<CardContent>
								<p className="text-sm text-muted-foreground">
									Login form with email/password, social providers, and responsive layout.
								</p>
							</CardContent>
						</Card>
					</Link>

					<Card className="h-full">
						<CardHeader>
							<div className="flex items-center gap-3">
								<div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
									<PanelLeft className="size-5 text-primary" />
								</div>
								<div>
									<CardTitle className="text-base">Sidebar</CardTitle>
									<CardDescription>Collapsible navigation</CardDescription>
								</div>
							</div>
						</CardHeader>
						<CardContent>
							<p className="text-sm text-muted-foreground">
								Multi-level sidebar with team switcher, project nav, and user menu.
							</p>
						</CardContent>
					</Card>
				</section>

				<Separator className="my-16" />

				<section>
					<h2 className="mb-8 text-center text-2xl font-semibold">Component Preview</h2>
					<ComponentShowcase />
				</section>

				<Separator className="my-16" />

				<section className="mx-auto max-w-2xl">
					<h2 className="mb-8 text-center text-2xl font-semibold">What&apos;s Included</h2>
					<div className="grid gap-4 sm:grid-cols-3">
						<div className="flex flex-col items-center gap-2 text-center">
							<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
								<Palette className="size-6 text-primary" />
							</div>
							<h3 className="font-medium">57 Components</h3>
							<p className="text-sm text-muted-foreground">
								Every shadcn/ui component, ready to import
							</p>
						</div>
						<div className="flex flex-col items-center gap-2 text-center">
							<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
								<Database className="size-6 text-primary" />
							</div>
							<h3 className="font-medium">D1 Database</h3>
							<p className="text-sm text-muted-foreground">
								SQLite database with global replication
							</p>
						</div>
						<div className="flex flex-col items-center gap-2 text-center">
							<div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
								<Zap className="size-6 text-primary" />
							</div>
							<h3 className="font-medium">Edge SSR</h3>
							<p className="text-sm text-muted-foreground">Server-rendered globally via OpenNext</p>
						</div>
					</div>
				</section>
			</main>

			<footer className="border-t py-6">
				<p className="text-center text-sm text-muted-foreground">
					Built with jack. Ship it with{" "}
					<code className="rounded bg-muted px-1 py-0.5">jack ship</code>
				</p>
			</footer>
		</div>
	);
}
