import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";

function ScrollButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
	const { isAtBottom, scrollToBottom } = useStickToBottomContext();

	return (
		<Button
			variant="outline"
			size="icon"
			className={cn(
				"h-8 w-8 rounded-full transition-all duration-150 ease-out",
				!isAtBottom
					? "translate-y-0 scale-100 opacity-100"
					: "pointer-events-none translate-y-4 scale-95 opacity-0",
				className,
			)}
			onClick={() => scrollToBottom()}
			{...props}
		>
			<ChevronDown className="h-4 w-4" />
		</Button>
	);
}

export { ScrollButton };
