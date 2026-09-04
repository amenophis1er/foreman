import React from 'react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { ToolCall } from './ToolCall';

/** A tool call waiting on the human: who wants what, the structured payload, and three decisions. */
export function ApprovalCard({ agent, title, toolName, decisionReason, input, onAllow, onAlways, onDeny, style }) {
  const tool = toolName || (title || '').replace(/^Wants to use\s+/i, '') || 'tool';
  return (
    <Card accent="var(--brand)" style={{ marginBottom: 'var(--sp-2)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'var(--fw-semibold)', color: 'var(--brand)', fontSize: 'var(--fs-sm)' }}>
        <Icon name="approval" size={14} strokeWidth={2} />
        <span>{agent} wants to use {tool}</span>
      </div>
      {decisionReason && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--status-serious)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>
          <Icon name="caution" size={12} strokeWidth={2} />{decisionReason}
        </div>
      )}
      <ToolCall tool={tool} input={typeof input === 'string' ? undefined : input} body={typeof input === 'string' ? input : undefined} defaultOpen style={{ margin: 'var(--sp-2) 0' }} />
      <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        <Button variant="good" onClick={onAllow}>Allow</Button>
        <Button variant="good" onClick={onAlways} title="Allow this tool for the rest of the run">Always (run)</Button>
        <Button variant="danger" onClick={onDeny}>Deny</Button>
      </div>
    </Card>
  );
}
