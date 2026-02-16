import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";

type ReasoningContextType = {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
};

const ReasoningContext = createContext<ReasoningContextType | undefined>(undefined);

function useReasoningContext() {
	const context = useContext(ReasoningContext);
	if (!context) {
		throw new Error("useReasoningContext must be used within a Reasoning provider");
	}
	return context;
}

function Reasoning({
	children,
	className,
	open,
	onOpenChange,
	isStreaming,
}: {
	children: React.ReactNode;
	className?: string;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	isStreaming?: boolean;
}) {
	const [internalOpen, setInternalOpen] = useState(false);
	const [wasAutoOpened, setWasAutoOpened] = useState(false);

	const isControlled = open !== undefined;
	const isOpen = isControlled ? open : internalOpen;

	const handleOpenChange = (newOpen: boolean) => {
		if (!isControlled) {
			setInternalOpen(newOpen);
		}
		onOpenChange?.(newOpen);
	};

	useEffect(() => {
		if (isStreaming && !wasAutoOpened) {
			if (!isControlled) setInternalOpen(true);
			setWasAutoOpened(true);
		}

		if (!isStreaming && wasAutoOpened) {
			if (!isControlled) setInternalOpen(false);
			setWasAutoOpened(false);
		}
	}, [isStreaming, wasAutoOpened, isControlled]);

	return (
		<ReasoningContext.Provider value={{ isOpen, onOpenChange: handleOpenChange }}>
			<div className={className}>{children}</div>
		</ReasoningContext.Provider>
	);
}

function ReasoningTrigger({
	children,
	className,
	...props
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLButtonElement>) {
	const { isOpen, onOpenChange } = useReasoningContext();

	return (
		<button
			type="button"
			className={cn("flex cursor-pointer items-center gap-1.5 text-xs", className)}
			onClick={() => onOpenChange(!isOpen)}
			{...props}
		>
			<span className="text-muted-foreground">{children}</span>
			<ChevronDown
				className={cn("h-3 w-3 text-muted-foreground transition-transform", isOpen && "rotate-180")}
			/>
		</button>
	);
}

function ReasoningContent({
	children,
	className,
	markdown = false,
	...props
}: {
	children: React.ReactNode;
	className?: string;
	markdown?: boolean;
} & React.HTMLAttributes<HTMLDivElement>) {
	const contentRef = useRef<HTMLDivElement>(null);
	const innerRef = useRef<HTMLDivElement>(null);
	const { isOpen } = useReasoningContext();

	useEffect(() => {
		if (!contentRef.current || !innerRef.current) return;

		const observer = new ResizeObserver(() => {
			if (contentRef.current && innerRef.current && isOpen) {
				contentRef.current.style.maxHeight = `${innerRef.current.scrollHeight}px`;
			}
		});

		observer.observe(innerRef.current);

		if (isOpen) {
			contentRef.current.style.maxHeight = `${innerRef.current.scrollHeight}px`;
		}

		return () => observer.disconnect();
	}, [isOpen]);

	return (
		<div
			ref={contentRef}
			className={cn("overflow-hidden transition-[max-height] duration-150 ease-out", className)}
			style={{ maxHeight: isOpen ? contentRef.current?.scrollHeight : "0px" }}
			{...props}
		>
			<div ref={innerRef} className="prose prose-sm dark:prose-invert text-muted-foreground">
				{markdown ? <Markdown>{children as string}</Markdown> : children}
			</div>
		</div>
	);
}

export { Reasoning, ReasoningTrigger, ReasoningContent };
