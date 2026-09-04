"use client";

import { cn } from "@/components/ui/utils";
import type { ComponentProps, ElementType } from "react";

export type TextShimmerProps = ComponentProps<"span"> & {
  as?: ElementType;
  duration?: number;
  spread?: number;
};

export const Shimmer = ({ as: Component = "span", className, duration: _duration, spread: _spread, ...props }: TextShimmerProps) => (
  <Component className={cn("animate-pulse", className)} {...props} />
);
