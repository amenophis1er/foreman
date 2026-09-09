import React, { useState } from 'react';
import { Card } from '../core/Card';
import { Icon } from '../core/Icon';
import { AgentDot, agentColor } from '../status/AgentDot';
import { ToolCall, parseToolInput, summarizeTool } from './ToolCall';
import { RichText } from '../core/RichText';

const MCP = new Set(['spawn_worker', 'message_worker', 'ask_human']);

/** One transcript row. Kind decides the accent; tool entries render as structured ToolCall chips. */
export function TranscriptEntry({ agent, title, kind = 'text', body, ts, to, timing, review, costBasis, dense = false, style }) {
  const isTool = kind === 'tool';
  if (isTool && dense) return <DenseToolLine agent={agent} title={title} body={body} ts={ts} style={style} />;
  if (kind === 'review' && review) return <ReviewCard agent={agent} review={review} ts={ts} costBasis={costBasis} style={style} />;
  // A turn marker with nothing to say beyond "this turn ended" is one quiet
  // line, not an empty card: the words it used to repeat are on the card above.
  if (kind === 'system' && !body && typeof title === 'string' && title.startsWith('result ·')) {
    return <TurnMarkLine agent={agent} title={title} ts={ts} style={style} />;
  }
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
          : <FoldedBody body={body} />}
    </Card>
  );
}

/**
 * A reviewer's verdict on the run's diff.
 *
 * A FAIL is not an error. The reviewer did its job and the answer was no —
 * so it wears `--status-serious`, the tone Foreman already uses for
 * "interrupted" and for a caution banner, and never `--status-critical`,
 * which in this app means something crashed. The word PASS or FAIL carries
 * the meaning; the colour only agrees with it.
 *
 * Nothing here is editable: presets are standing configuration, changed in
 * Settings, and a verdict is a record of what happened.
 */
function ReviewCard({ agent, review, ts, costBasis, style }) {
  const pass = Boolean(review.pass);
  const tone = pass ? 'var(--status-good)' : 'var(--status-serious)';
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : null;
  // The same honesty rule as the meter: a dollar only where the dollar is real.
  const cost = costBasis === 'priced' && typeof review.costUsd === 'number'
    ? `$${review.costUsd.toFixed(2)}` : null;
  return (
    <Card accent={tone} style={{ padding: 'var(--sp-2) var(--sp-3)', ...style }}>
      <div style={{
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginBottom: 6,
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontFamily: 'var(--font-ui)',
      }}>
        <AgentDot agent={agent} size="sm" />
        <span>{agent}</span>
        <span>·</span>
        <span style={{ color: 'var(--ink-1)' }}>{review.name}</span>
        {review.model && <><span>·</span><span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: 'var(--font-mono)' }}><Icon name="model" size={11} />{review.model}</span></>}
        {cost && <><span>·</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{cost}</span></>}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4,
          padding: '1px 8px 1px 6px', borderRadius: 'var(--r-pill)',
          background: 'var(--bg-inset)', border: '1px solid var(--line)',
          color: 'var(--ink-1)', letterSpacing: '0.04em',
        }}>
          <Icon name={pass ? 'check' : 'caution'} size={11} strokeWidth={2.25} color={tone} />
          {pass ? 'PASS' : 'FAIL'}
        </span>
        {time && <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span>}
      </div>
      {review.findings?.trim()
        ? <FoldedBody body={review.findings} rich />
        : <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-2)' }}>
            {pass ? 'Nothing to raise.' : 'No findings were given.'}
          </div>}
    </Card>
  );
}

const FOLD_LINES = 12;

const BULLET = /^\s*[-*]\s+/;
const BLOCK_START = /^(```|>|\s*[-*]\s|#{1,3}\s)/;

/**
 * Folds a wrapped bullet back onto one line.
 *
 * The block parser is line-based: a bullet is one line, and the second line of
 * a bullet a reviewer wrapped by hand became a flush-left paragraph of its own
 * with full paragraph spacing — a five-finding review read as ten alternating
 * fragments. Findings are written in exactly that shape, so this is the common
 * case. A continuation is any non-blank line after a bullet that does not start
 * a block of its own; a blank line ends the item, and a fence is left alone.
 */
function joinListContinuations(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inFence = false;
  let inItem = false;
  for (const line of lines) {
    if (/^```/.test(line)) { inFence = !inFence; inItem = false; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (BULLET.test(line)) { inItem = true; out.push(line); continue; }
    if (inItem && line.trim() && !BLOCK_START.test(line)) {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
      continue;
    }
    inItem = false;
    out.push(line);
  }
  return out.join('\n');
}

/**
 * A long payload — a worker's tool result, a file it read back — folded to
 * its first lines with the rest one click away. A 90-line JSON dump is
 * evidence, not narrative; it must not push the next decision off screen.
 *
 * `rich` renders the shown text as prose and lists instead of mono-ish
 * pre-wrap: a reviewer's findings are written to be read, and they fold on
 * exactly the same affordance so there is only ever one "Show all" in the
 * transcript. Hand-wrapped bullets are rejoined first — see
 * `joinListContinuations`.
 */
function FoldedBody({ body, rich = false }) {
  const [open, setOpen] = useState(false);
  const text = typeof body === 'string' ? body : null;
  const lines = text ? text.split('\n') : [];
  const long = text !== null && (lines.length > FOLD_LINES + 4 || text.length > 1600);
  const plain = (t) => rich
    ? <RichText text={joinListContinuations(t)} />
    : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t}</div>;
  if (!long) return rich && text !== null ? plain(text) : <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{body}</div>;
  const shown = open ? text : lines.slice(0, FOLD_LINES).join('\n').slice(0, 1600);
  return (
    <div>
      {/* The fold's ellipsis gets a blank line before it so it stays a block of
          its own instead of being joined onto the bullet it was cut after. */}
      {rich ? plain(open ? shown : `${shown}\n\n…`) :<div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{shown}{!open && '\n…'}</div>}
      <button type="button" onClick={() => setOpen(!open)} style={{
        marginTop: 4, padding: 0, background: 'none', border: 'none', cursor: 'pointer',
        font: 'inherit', fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-xs)', color: 'var(--brand)',
      }}>
        {open ? 'Show less' : `Show all · ${lines.length} lines`}
      </button>
    </div>
  );
}

/** End of an agent's turn, as a line: dot, "result · success", time. */
function TurnMarkLine({ agent, title, ts, style }) {
  const time = ts ? new Date(ts).toLocaleTimeString(undefined, { hour12: false }) : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '1px var(--sp-2)',
      fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', ...style,
    }}>
      <AgentDot agent={agent} size="sm" />
      <span>{agent}</span><span>·</span><span>{title.replace(/^result · /, 'turn ended · ')}</span>
      {time && <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{time}</span>}
    </div>
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
