import React from 'react';
import { Card } from '../core/Card';
import { Icon } from '../core/Icon';
import { AgentDot, agentColor } from '../status/AgentDot';
import { ToolCall, parseToolInput, summarizeTool } from './ToolCall';
import { RichText } from '../core/RichText';

const MCP = new Set(['spawn_worker', 'message_worker', 'ask_human']);

/** One transcript row. Kind decides the accent; tool entries render as structured ToolCall chips. */
export function TranscriptEntry({ agent, title, kind = 'text', body, ts, to, timing, dense = false, style }) {
  const isTool = kind === 'tool';
  if (isTool && dense) return <DenseToolLine agent={agent} title={title} body={body} ts={ts} style={style} />;
  const steer = kind === 'steer';
  const mono = kind === 'result';
  const accent = kind === 'error' ? 'var(--status-critical)' : steer ? 'var(--ink-0)' : kind === 'text' ? agentColor(agent) : undefined;
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : null;
  const toolName = isTool ? String(title || 'tool').replace(/^[^\w]+/, '') : null;
  const label = isTool ? null : title;
  return (
    <Card accent={accent} style={{
      padding: 'var(--sp-2) var(--sp-3)',
      ...(mono ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' } : null),
      ...(kind === 'system' ? { color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' } : null),
      ...style,
    }}>
      <div style={{
        fontSize: 'var(--fs-xs)', color: kind === 'error' ? 'var(--status-critical)' : 'var(--ink-2)',
        marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-ui)',
      }}>
        <AgentDot agent={agent} size="sm" />
        <span>{agent}</span>
        {steer && to && <><Icon name="chevronRight" size={11} /><AgentDot agent={to} size="sm" /><span>{to}</span></>}
        {steer && timing && <><span>·</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name={timing === 'now' ? 'now' : 'nextTurn'} size={11} />{timing === 'now' ? 'now' : 'next turn'}</span></>}
        {label && label !== agent && <><span>·</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>{kind === 'error' && <Icon name="error" size={11} strokeWidth={2.25} />}{label}</span></>}
        {isTool && MCP.has(toolName) && <><span>·</span><span style={{ color: 'var(--brand)' }}>orchestration</span></>}
        {time && <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span>}
      </div>
      {isTool
        ? <ToolCall tool={toolName} body={body} />
        : kind === 'text' && typeof body === 'string'
          ? <RichText text={body} />
          : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body}</div>}
    </Card>
  );
}

/**
 * A tool call as one quiet mono line — no card, no chip, no payload. Weight
 * follows meaning: a run makes hundreds of these and a handful of decisions,
 * and when every Read is a card the decisions drown. The full call is still
 * one hover away in the title; the deck shows what the writes amounted to.
 */
function DenseToolLine({ agent, title, body, ts, style }) {
  const tool = String(title || 'tool').replace(/^[^\w]+/, '');
  const summary = summarizeTool(tool, parseToolInput(body)) || (typeof body === 'string' ? body : '');
  const args = String(summary).replace(/\s+/g, ' ').slice(0, 90);
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : null;
  return (
    <div title={typeof body === 'string' ? body.slice(0, 2000) : undefined} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '1px var(--sp-2)',
      fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
      whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0, ...style,
    }}>
      <AgentDot agent={agent} size="sm" />
      <Icon name={tool} size={12} />
      <span style={{ color: MCP.has(tool) ? 'var(--brand)' : 'var(--ink-1)', flex: '0 0 auto' }}>{tool}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{args}</span>
      {time && <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{time}</span>}
    </div>
  );
}
