import { cn } from "@/lib/utils";
import { Markdown } from "./markdown";

function Message({
	children,
	className,
	...props
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={cn("flex gap-3", className)} {...props}>
			{children}
		</div>
	);
}

function MessageAvatar({ initials, className }: { initials: string; className?: string }) {
	return (
		<div
			className={cn(
				"flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground",
				className,
			)}
		>
			{initials}
		</div>
	);
}

function MessageContent({
	children,
	markdown = false,
	className,
	...props
}: {
	children: React.ReactNode;
	markdown?: boolean;
	className?: string;
} & React.HTMLAttributes<HTMLDivElement>) {
	if (markdown) {
		return (
			<div className={cn("prose prose-sm dark:prose-invert min-w-0", className)} {...props}>
				<Markdown>{children as string}</Markdown>
			</div>
		);
	}

	return (
		<div className={cn("text-sm", className)} {...props}>
			{children}
		</div>
	);
}

export { Message, MessageAvatar, MessageContent };
