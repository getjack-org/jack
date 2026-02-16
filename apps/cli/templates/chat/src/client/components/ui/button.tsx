import { cn } from "@/lib/utils";
import { type VariantProps, cva } from "class-variance-authority";
import { Slot } from "radix-ui";

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
				outline:
					"border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
				secondary: "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",
				ghost: "hover:bg-accent hover:text-accent-foreground",
			},
			size: {
				default: "h-9 px-4 py-2",
				sm: "h-8 rounded-md px-3",
				lg: "h-10 rounded-md px-6",
				icon: "size-9",
			},
		},
		defaultVariants: { variant: "default", size: "default" },
	},
);

function Button({
	className,
	variant,
	size,
	asChild = false,
	...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
	const Comp = asChild ? Slot.Root : "button";
	return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
