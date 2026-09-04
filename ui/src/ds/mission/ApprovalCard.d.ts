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
  onAllow?: () => void;
  /** Grants this tool for the rest of the run (survives resume). Guarded asks still prompt. */
  onAlways?: () => void;
  onDeny?: () => void;
  style?: CSSProperties;
}

export declare function ApprovalCard(props: ApprovalCardProps): JSX.Element;
