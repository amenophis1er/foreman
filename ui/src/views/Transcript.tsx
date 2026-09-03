import { useEffect, useRef } from 'react';
import type { RunView } from '../state';
import { Card, Empty, agentColor } from '../design/ui';

const KIND_COLOR: Record<string, string | undefined> = {
  error: 'var(--status-critical)',
};

export function Transcript({ s, filter }: { s: RunView; filter: string | null }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  const entries = filter ? s.entries.filter((e) => e.agent === filter) : s.entries;

  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      style={{ overflowY: 'auto', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      {entries.length === 0 && <Empty>Transcript will appear here.</Empty>}
      {entries.map((e) => (
        <Card key={e.id}
          accent={e.kind === 'error' ? 'var(--status-critical)'
            : e.kind === 'text' ? agentColor(e.agent) : undefined}
          style={{
            padding: 'var(--sp-2) var(--sp-3)',
            ...(e.kind === 'tool' || e.kind === 'result'
              ? { fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' } : {}),
            ...(e.kind === 'system' ? { color: 'var(--ink-1)', fontSize: 'var(--fs-sm)' } : {}),
          }}>
          <div style={{
            fontSize: 'var(--fs-xs)', color: KIND_COLOR[e.kind] ?? 'var(--ink-2)',
            marginBottom: 2, display: 'flex', gap: 'var(--sp-2)', fontFamily: 'var(--font-ui)',
          }}>
            <span aria-hidden style={{
              width: 6, height: 6, borderRadius: 999, background: agentColor(e.agent),
              alignSelf: 'center',
            }} />
            {e.agent !== e.title ? `${e.agent} · ${e.title}` : e.title}
            <span style={{ marginLeft: 'auto' }}>
              {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
            </span>
          </div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.body}</div>
        </Card>
      ))}
    </div>
  );
}
