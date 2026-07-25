import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] text-[12.5px] font-semibold tracking-normal transition-[background-color,border-color,color,box-shadow,opacity,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[#2d7ff0]/20 disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "border border-[#1d2935] bg-[#1d2935] text-white hover:bg-[#2a3c4a]",
        destructive: "bg-[#dc2626] text-white hover:bg-[#b91c1c]",
        outline:
          "border border-[#d7e2ea] bg-white text-[#53616d] hover:border-[#b8cddd] hover:bg-[#f8fbfd] hover:text-[#1d2935]",
        secondary:
          "bg-[#eef5f9] text-[#53616d] hover:bg-[#e4f0f7] hover:text-[#1d2935]",
        ghost: "text-[#73818d] hover:bg-[#eef5f9] hover:text-[#1d2935]",
        link: "text-[#1d2935] underline-offset-4 hover:underline font-medium",
      },
      size: {
        default: "h-[35px] px-3.5",
        sm: "h-[30px] rounded-[8px] px-2.5 text-[12px]",
        lg: "h-[39px] rounded-[10px] px-4 text-[13px]",
        icon: "h-[35px] w-[35px] p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
