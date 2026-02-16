import { cn } from "@/lib/utils";
import { memo, useId, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

function extractLanguage(className?: string): string {
	if (!className) return "plaintext";
	const match = className.match(/language-(\w+)/);
	return match ? match[1] : "plaintext";
}

const components: Partial<Components> = {
	code: function CodeComponent({ className, children, ...props }) {
		const isInline =
			!props.node?.position?.start.line ||
			props.node?.position?.start.line === props.node?.position?.end.line;

		if (isInline) {
			return (
				<code
					className={cn("rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.85em]", className)}
					{...props}
				>
					{children}
				</code>
			);
		}

		const language = extractLanguage(className);

		return (
			<div className="not-prose my-3 overflow-clip rounded-lg border border-border bg-card">
				{language !== "plaintext" && (
					<div className="flex items-center justify-between border-b border-border bg-secondary/50 px-3 py-1.5">
						<span className="text-xs text-muted-foreground">{language}</span>
					</div>
				)}
				<pre className="overflow-x-auto p-3">
					<code className="text-[13px] leading-relaxed">{children}</code>
				</pre>
			</div>
		);
	},
	pre: function PreComponent({ children }) {
		return <>{children}</>;
	},
};

const MemoizedMarkdownBlock = memo(
	function MarkdownBlock({ content }: { content: string }) {
		return (
			<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
				{content}
			</ReactMarkdown>
		);
	},
	(prev, next) => prev.content === next.content,
);
MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock";

function MarkdownComponent({
	children,
	id,
	className,
}: { children: string; id?: string; className?: string }) {
	const generatedId = useId();
	const blockId = id ?? generatedId;
	const blocks = useMemo(() => children.split(/\n\n+/), [children]);

	return (
		<div className={className}>
			{blocks.map((block, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: stable blockId prefix makes this safe
				<MemoizedMarkdownBlock key={`${blockId}-${index}`} content={block} />
			))}
		</div>
	);
}

const Markdown = memo(MarkdownComponent);
Markdown.displayName = "Markdown";

export { Markdown };
