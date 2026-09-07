import React, { useEffect, useState } from 'react';
import { Icon } from '../core/Icon';
import { Button } from '../core/Button';

const GLYPH = {
  ok: { icon: 'done', color: 'var(--status-good)' },
  warn: { icon: 'caution', color: 'var(--status-serious)' },
  error: { icon: 'critical', color: 'var(--status-critical)' },
};

/**
 * The first-run card: what `foreman doctor` knows, shown where a new person
 * is looking. Not a wizard — Foreman has no required choices — but a short
 * list of what this machine has and, for anything missing, the one thing to
 * do about it. It never asks for a key or a token here; those keep their
 * write-only homes in Settings.
 *
 * `load` fetches `/doctor`; the card re-asks when told to, so a login done in
 * another terminal shows up without a restart.
 */
export function SetupCard({ load, onSettings, style }) {
  const [checks, setChecks] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const r = await load();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setChecks((await r.json()).checks ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const attention = (checks ?? []).filter((c) => c.status !== 'ok').length;
  return (
    <section style={{
      border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--bg-card)',
      padding: 'var(--sp-3) var(--sp-4)', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', ...style,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', flex: 1 }}>This machine</span>
        {checks && (
          <span style={{ fontSize: 'var(--fs-xs)', color: attention ? 'var(--status-serious)' : 'var(--ink-2)' }}>
            {attention ? `${attention} thing${attention === 1 ? '' : 's'} to look at` : 'ready'}
          </span>
        )}
        <Button variant="ghost" size="sm" icon={busy ? 'loading' : 'resume'} onClick={run} disabled={busy}>Check again</Button>
      </header>
      {error && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-critical)' }}>Could not run the checks: {error}</div>}
      {!checks && !error && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>Checking…</div>}
      {checks && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {checks.map((c) => {
            const g = GLYPH[c.status] || GLYPH.warn;
            return (
              <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr)', columnGap: 'var(--sp-2)', padding: '5px 0', borderTop: '1px solid var(--line)', fontSize: 'var(--fs-sm)' }}>
                <Icon name={g.icon} size={14} color={g.color} style={{ marginTop: 2 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'baseline', minWidth: 0 }}>
                    <span style={{ color: 'var(--ink-0)', flex: '0 0 auto' }}>{c.name}</span>
                    <span style={{ color: 'var(--ink-2)', minWidth: 0, overflowWrap: 'anywhere' }}>{c.detail}</span>
                  </div>
                  {c.fix && c.status !== 'ok' && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-1)', marginTop: 2, overflowWrap: 'anywhere' }}>{c.fix}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>
        A project can run on a provider of its own — an Anthropic API key, a Codex login or any OpenAI-compatible endpoint — from{' '}
        <button type="button" onClick={onSettings} style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--brand)', cursor: 'pointer', textDecoration: 'underline' }}>Settings → Provider</button>
        {' '}once it is linked.
      </div>
    </section>
  );
}
