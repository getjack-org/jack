import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function PromptSuggestion({
	children,
	className,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<Button
			variant="outline"
			className={cn("h-auto rounded-full px-4 py-2 text-sm font-normal", className)}
			{...props}
		>
			{children}
		</Button>
	);
}

export { PromptSuggestion };
