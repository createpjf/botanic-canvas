"use client";

import { cn } from "@/components/ui/utils";
import type { MotionProps } from "motion/react";
import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties, ElementType, JSX } from "react";
import { memo, useMemo } from "react";

type MotionHTMLProps = MotionProps & Record<string, unknown>;

const motionComponentCache = new Map<
  keyof JSX.IntrinsicElements,
  React.ComponentType<MotionHTMLProps>
>();

const getMotionComponent = (element: keyof JSX.IntrinsicElements) => {
  let component = motionComponentCache.get(element);
  if (!component) {
    component = motion.create(element);
    motionComponentCache.set(element, component);
  }
  return component;
};

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const reduceMotion = useReducedMotion();
  const MotionComponent = getMotionComponent(
    Component as keyof JSX.IntrinsicElements
  );
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return (
    <MotionComponent
      animate={reduceMotion ? undefined : { backgroundPosition: "0% center" }}
      className={cn(
        reduceMotion
          ? "relative inline-block text-[var(--color-muted-foreground)]"
          : "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={reduceMotion ? false : { backgroundPosition: "100% center" }}
      style={reduceMotion ? { color: "var(--color-muted-foreground)", WebkitTextFillColor: "currentColor" } :
        {
          color: "transparent",
          WebkitTextFillColor: "transparent",
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={reduceMotion ? undefined : {
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
