import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { ModelSelect } from '../forms/ModelSelect';

/**
 * The Resume control: a split button. The wide half resumes as is; the caret
 * opens "on other models" — pick a director and workers, resume with those,
 * without a trip through Settings. The case the caret exists for is a
 * provider saying no — a usage limit, an outage — when the work is fine and
 * only the endpoint is not: pick another, resume, keep going.
 */
export function ResumeMenu({ director, worker, models, loading, note, busy, onResume, style }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState({ id: director || '', providerId: undefined });
  const [wk, setW] = useState({ id: worker || '', providerId: undefined });
  const box = useRef(null);

  useEffect(() => { setD({ id: director || '', providerId: undefined }); setW({ id: worker || '', providerId: undefined }); }, [director, worker, open]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const changed = (d.id && d.id !== director) || (wk.id && wk.id !== worker);
  const go = () => {
    onResume?.({
      ...(d.id && d.id !== director ? { directorModel: d.id, directorProviderId: d.providerId } : {}),
      ...(wk.id && wk.id !== worker ? { workerModel: wk.id, workerProviderId: wk.providerId } : {}),
    });
    setOpen(false);
  };
  const label = { fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: 'var(--ls-caps)', marginBottom: 4 };

  return (
    <div ref={box} style={{ position: 'relative', display: 'inline-flex', ...style }}>
      <Button variant="good" icon="resume" disabled={busy}
        title="Restore the director's session and continue this mission"
        onClick={() => onResume?.({})}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
        {busy ? 'Resuming…' : 'Resume'}
      </Button>
      <Button variant="good" disabled={busy} aria-label="Resume on other models" title="Resume on other models…"
        onClick={() => setOpen(!open)}
        style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: '1px solid rgba(255,255,255,0.35)', paddingLeft: 6, paddingRight: 6 }}>
        <Icon name="chevronDown" size={14} />
      </Button>
      {open && (
        <div role="dialog" aria-label="Resume on other models" style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50, width: 340,
          background: 'var(--bg-card)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-md)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.25)', padding: 'var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)',
        }}>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', lineHeight: 'var(--lh)' }}>
            Same mission, other models. A new director starts a fresh session and reads the mission doc; workers change for the next spawns.
          </div>
          <div>
            <div style={label}>Director</div>
            <ModelSelect block allowDefault={false} models={models} loading={loading} note={note} value={d.id}
              onChange={(id, m) => setD({ id, providerId: m?.providerId })} />
          </div>
          <div>
            <div style={label}>Workers</div>
            <ModelSelect block allowDefault={false} models={models} loading={loading} note={note} value={wk.id}
              onChange={(id, m) => setW({ id, providerId: m?.providerId })} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="good" size="sm" icon="resume" disabled={busy || !changed} onClick={go}
              title={changed ? 'Resume with these models' : 'Pick a different model first — or use Resume as is'}>Resume</Button>
          </div>
        </div>
      )}
    </div>
  );
}
