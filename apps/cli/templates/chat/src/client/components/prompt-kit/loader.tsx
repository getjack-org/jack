import { cn } from "@/lib/utils";

function TypingLoader({
	className,
	size = "md",
}: { className?: string; size?: "sm" | "md" | "lg" }) {
	const dotSizes = { sm: "h-1 w-1", md: "h-1.5 w-1.5", lg: "h-2 w-2" };
	return (
		<div className={cn("flex items-center space-x-1", className)}>
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					className={cn("bg-muted-foreground/60 animate-bounce rounded-full", dotSizes[size])}
					style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
				/>
			))}
			<span className="sr-only">Loading</span>
		</div>
	);
}

function TextShimmerLoader({
	text = "Thinking",
	className,
}: { text?: string; className?: string }) {
	return (
		<span className={cn("animate-pulse text-sm font-medium text-muted-foreground", className)}>
			{text}...
		</span>
	);
}

export { TypingLoader, TextShimmerLoader };
