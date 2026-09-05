import type { CSSProperties } from 'react';

/**
 * The permission gate. Lives in the right rail; gold-accented because approvals are the human's job.
 */
export interface ApprovalCardProps {
  /** Requesting agent id, shown in brackets: `[worker-1]`. */
  agent: string;
  /** Human-readable ask. Falls back to `Wants to use <toolName>`. */
  title?: string;
  toolName?: string;
  /** Why the policy escalated instead of auto-allowing — rendered as a caution line in serious color. */
  decisionReason?: string;
  /** Tool input. Rendered through `ToolCall` (expanded): diff for Write/Edit, pretty JSON otherwise. */
  input?: unknown;
  /**
   * Set when the ask came from the folder boundary: the directory "always"
   * will open for the run. Relabels the middle button `Allow this path (run)`
   * with the path in its tooltip, because there the grant is a path, not a tool.
   */
  escapedPath?: string;
  onAllow?: () => void;
  /**
   * Grants this tool for the rest of the run (survives resume) — or, when
   * `escapedPath` is set, grants that directory instead. Guarded asks still prompt.
   */
  onAlways?: () => void;
  onDeny?: () => void;
  style?: CSSProperties;
}

export declare function ApprovalCard(props: ApprovalCardProps): JSX.Element;
