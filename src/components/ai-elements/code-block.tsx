"use client";

import { cn } from "@/components/ui/utils";
import type { ComponentProps } from "react";

export type CodeBlockProps = Omit<ComponentProps<"pre">, "children"> & {
  code: string;
  language?: string;
};

/** Tool 参数/输出只需要可复制的原文；语法高亮留给正式代码消息。 */
export const CodeBlock = ({
  className,
  code,
  language = "text",
  ...props
}: CodeBlockProps) => (
  <pre
    className={cn(
      "max-h-80 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-xs",
      className
    )}
    {...props}
  >
    <code data-language={language}>{code}</code>
  </pre>
);
