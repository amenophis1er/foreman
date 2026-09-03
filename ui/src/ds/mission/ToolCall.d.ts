import type { CSSProperties } from 'react';

/**
 * Structured rendering of a tool call (debt item 3): a mono chip with the tool's icon and name, a one-line
 * summary (path, command, pattern…), and an expandable body that shows a diff for Write/Edit/MultiEdit
 * or the pretty-printed payload for everything else. Foreman MCP tools (spawn_worker, message_worker,
 * ask_human) get a gold chip.
 */
export interface ToolCallProps {
  /** Tool name as the agent called it: `Write`, `Bash`, `spawn_worker`… */
  tool?: string;
  /** Parsed payload. If omitted, `body` is JSON-parsed. */
  input?: Record<string, unknown>;
  /** Raw payload string (transcript entries carry this). */
  body?: string;
  defaultOpen?: boolean;
  style?: CSSProperties;
}

export declare function ToolCall(props: ToolCallProps): JSX.Element;
/** Old → new line rendering for Edit/MultiEdit; Write renders the content as additions. */
export declare function DiffView(props: { tool: string; input: Record<string, unknown> }): JSX.Element | null;
export declare function summarizeTool(tool: string, input: Record<string, unknown> | null): string;
export declare function parseToolInput(body: unknown): Record<string, unknown> | null;
/** Bundle-reachable aliases: `ToolCallUtils.parseToolInput`, `ToolCallUtils.summarizeTool`. */
export declare const ToolCallUtils: { parseToolInput: typeof parseToolInput; summarizeTool: typeof summarizeTool };
