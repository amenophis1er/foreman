import type { CSSProperties } from 'react';

/** Marks who is speaking or acting. 8px in the agent rail, 6px in transcript meta rows. */
export interface AgentDotProps {
  /** Agent id. `'director'` → brand gold; `worker-N` → `--agent-worker-((N-1)%6+1)`. */
  agent: string;
  /** `md` = 8px (agent rail) · `sm` = 6px (transcript meta) */
  size?: 'md' | 'sm';
  style?: CSSProperties;
}

export declare function AgentDot(props: AgentDotProps): JSX.Element;
/** Director → `var(--brand)`; worker-N → a fixed slot on the six-hue violet ramp. Same id always gives the same color. */
export declare function agentColor(agent: string): string;
/** Same function, reachable from the bundle as `window.<Namespace>.AgentColor`. */
export declare const AgentColor: typeof agentColor;
