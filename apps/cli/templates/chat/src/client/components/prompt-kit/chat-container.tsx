import { cn } from "@/lib/utils";
import { StickToBottom } from "use-stick-to-bottom";

function ChatContainerRoot({
	children,
	className,
	...props
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<StickToBottom
			className={cn("flex overflow-y-auto", className)}
			resize="smooth"
			initial="instant"
			role="log"
			{...props}
		>
			{children}
		</StickToBottom>
	);
}

function ChatContainerContent({
	children,
	className,
	...props
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<StickToBottom.Content className={cn("flex w-full flex-col", className)} {...props}>
			{children}
		</StickToBottom.Content>
	);
}

function ChatContainerScrollAnchor({
	className,
	...props
}: { className?: string } & React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn("h-px w-full shrink-0 scroll-mt-4", className)}
			aria-hidden="true"
			{...props}
		/>
	);
}

export { ChatContainerRoot, ChatContainerContent, ChatContainerScrollAnchor };
