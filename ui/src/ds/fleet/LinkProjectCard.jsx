import React, { useState } from 'react';
import { Icon } from '../core/Icon';

/** The dashed tile that opens the folder picker. The fleet's empty state; a
 *  populated fleet carries the action as a header button instead. */
export function LinkProjectCard({ onClick, style }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        border: `1px dashed ${hover ? 'var(--ink-2)' : 'var(--line-strong)'}`,
        borderRadius: 'var(--r-md)', minHeight: 'var(--card-min-h)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 'var(--sp-2)', cursor: 'pointer', color: hover ? 'var(--ink-0)' : 'var(--ink-1)',
        background: hover ? 'var(--bg-hover)' : 'transparent',
        transition: 'border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)', ...style,
      }}
    >
      <Icon name="add" size={22} strokeWidth={1.5} />
      <span style={{ fontSize: 'var(--fs-sm)' }}>Link a project</span>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>or drop a folder anywhere</span>
    </div>
  );
}
