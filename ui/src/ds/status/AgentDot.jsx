import React from 'react';

/** Identity color for an agent id. Director is brand gold; workers take a fixed hue from the six-step violet ramp by index. */
export function agentColor(agent) {
  if (agent === 'director') return 'var(--brand)';
  if (agent === 'you') return 'var(--ink-0)';
  const m = /(\d+)/.exec(String(agent || ''));
  const n = m ? ((parseInt(m[1], 10) - 1) % 6) + 1 : 1;
  return `var(--agent-worker-${n})`;
}

/** Bundle-reachable alias of `agentColor` (only PascalCase exports are exposed on the window namespace). */
export const AgentColor = agentColor;

/** The identity dot: a filled circle in the agent's fixed color. */
export function AgentDot({ agent, size = 'md', style }) {
  const d = size === 'sm' ? 'var(--dot-sm)' : 'var(--dot)';
  return (
    <span aria-hidden style={{
      width: d, height: d, borderRadius: 'var(--r-pill)',
      background: agentColor(agent), flex: '0 0 auto', ...style,
    }} />
  );
}
