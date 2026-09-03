import React, { useState } from 'react';
import { Icon } from '../core/Icon';

/** Best-effort parse of a tool payload string. */
export function parseToolInput(body) {
  if (body == null) return null;
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch { return null; }
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p;
}

/** One-line human summary of a tool call. */
export function summarizeTool(tool, input) {
  if (!input) return '';
  switch (tool) {
    case 'Write': case 'Edit': case 'MultiEdit': case 'Read': return shortPath(input.file_path || input.path);
    case 'Bash': return input.command || '';
    case 'Grep': return `${input.pattern ?? ''}${input.path ? ' in ' + shortPath(input.path) : ''}`;
    case 'Glob': return input.pattern || '';
    case 'WebFetch': case 'WebSearch': return input.url || input.query || '';
    case 'spawn_worker': return `${input.id ?? 'worker'} — ${(input.task || '').slice(0, 80)}`;
    case 'message_worker': return `${input.id ?? 'worker'} — ${(input.message || '').slice(0, 80)}`;
    case 'ask_human': return input.question || '';
    default: {
      const k = Object.keys(input)[0];
      return k ? `${k}: ${String(input[k]).slice(0, 80)}` : '';
    }
  }
}

function Lines({ text, tone, max = 12 }) {
  const lines = String(text ?? '').split('\n');
  const shown = lines.slice(0, max);
  const bg = tone === 'add' ? 'var(--diff-add-bg)' : tone === 'del' ? 'var(--diff-del-bg)' : 'transparent';
  const sign = tone === 'add' ? '+' : tone === 'del' ? '−' : ' ';
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', lineHeight: 1.5 }}>
      {shown.map((l, i) => (
        <div key={i} style={{ display: 'flex', background: bg, padding: '0 8px' }}>
          <span style={{ width: 14, flex: '0 0 auto', color: tone === 'add' ? 'var(--status-good)' : tone === 'del' ? 'var(--status-critical)' : 'var(--ink-2)' }}>{sign}</span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-0)' }}>{l}</span>
        </div>
      ))}
      {lines.length > max && <div style={{ padding: '2px 8px', color: 'var(--ink-2)' }}>… {lines.length - max} more lines</div>}
    </div>
  );
}

/** Old → new rendering for Edit / MultiEdit payloads; Write shows the new content as additions. */
export function DiffView({ tool, input }) {
  if (!input) return null;
  if (tool === 'Write') return <Lines text={input.content} tone="add" />;
  const edits = tool === 'MultiEdit' ? (input.edits || []) : [input];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {edits.map((e, i) => (
        <div key={i}>
          <Lines text={e.old_string} tone="del" max={8} />
          <Lines text={e.new_string} tone="add" max={8} />
        </div>
      ))}
    </div>
  );
}

const MCP = new Set(['spawn_worker', 'message_worker', 'ask_human']);

/** Bundle-reachable aliases (only PascalCase exports are exposed on the window namespace). */
export const ToolCallUtils = { parseToolInput, summarizeTool };

/** Structured tool call: icon chip + summary, expandable to a diff or the raw payload. */
export function ToolCall({ tool = 'tool', input, body, defaultOpen = false, style }) {
  const parsed = input ?? parseToolInput(body);
  const [open, setOpen] = useState(defaultOpen);
  const [raw, setRaw] = useState(false);
  const isMcp = MCP.has(tool);
  const hasDiff = parsed && (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit');
  const summary = summarizeTool(tool, parsed) || (typeof body === 'string' ? body.slice(0, 120) : '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      <button type="button" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: 0, background: 'none', border: 'none',
        cursor: 'pointer', color: 'var(--ink-0)', textAlign: 'left', width: '100%', font: 'inherit',
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px 2px 6px', borderRadius: 'var(--r-pill)',
          background: isMcp ? 'var(--brand-wash-strong)' : 'var(--bg-inset)', border: `1px solid ${isMcp ? 'var(--brand)' : 'var(--line)'}`,
          color: isMcp ? 'var(--brand)' : 'var(--ink-1)', fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)',
          fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', lineHeight: '16px',
        }}>
          <Icon name={tool} size={12} strokeWidth={2} />{tool}
        </span>
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{summary}</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} color="var(--ink-2)" />
      </button>
      {open && (
        <div style={{ background: 'var(--bg-inset)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderBottom: '1px solid var(--line)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            <span>{hasDiff && !raw ? 'changes' : 'payload'}</span>
            <span style={{ flex: 1 }} />
            {hasDiff && (
              <button type="button" onClick={() => setRaw(!raw)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: 'var(--ink-2)', cursor: 'pointer', font: 'inherit', padding: 0 }}>
                <Icon name="raw" size={12} />{raw ? 'diff' : 'raw'}
              </button>
            )}
          </div>
          <div style={{ padding: '6px 0', maxHeight: 260, overflow: 'auto' }}>
            {hasDiff && !raw ? <DiffView tool={tool} input={parsed} /> : (
              <pre style={{ margin: 0, padding: '0 8px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-0)' }}>
                {parsed ? JSON.stringify(parsed, null, 2) : String(body ?? '')}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
