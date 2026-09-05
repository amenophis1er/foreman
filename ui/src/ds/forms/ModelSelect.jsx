import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../core/Icon';

/** Used until `GET /models` answers (or when it fails). Same shape the endpoint returns. */
export const FALLBACK_MODELS = [
  { id: 'fable', label: 'Fable', model: 'claude-fable-5', cost: 4, note: 'Frontier. Long-horizon planning and verification.' },
  { id: 'opus', label: 'Opus', model: 'claude-opus-5', cost: 3, note: 'Deep reasoning for hard refactors.' },
  { id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet-5', cost: 2, note: 'Balanced. The usual worker.' },
  { id: 'haiku', label: 'Haiku', model: 'claude-haiku-4-5', cost: 1, note: 'Fast and cheap for reads and mechanical edits.' },
];
const INHERIT = { id: '', label: 'Default', model: 'inherits your Claude Code default', cost: 0 };

/**
 * Loads the model list once. `source` is a URL (`'/models'` → `{models:[…]}`) or an async function returning the array.
 * Pass a stable reference (module-level fn or constant string), not an inline closure.
 */
function useModels(source) {
  const [state, setState] = useState({ models: null, loading: Boolean(source), error: null });
  useEffect(() => {
    if (!source) return undefined;
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    const p = typeof source === 'string'
      ? fetch(source).then((r) => { if (!r.ok) throw new Error(`${r.status} from ${source}`); return r.json(); }).then((j) => j.models || j)
      : Promise.resolve().then(source);
    p.then((models) => live && setState({ models, loading: false, error: null }))
      .catch((e) => live && setState({ models: null, loading: false, error: String(e && e.message || e) }));
    return () => { live = false; };
  }, [source]);
  return state;
}

function CostMark({ cost }) {
  if (!cost) return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>—</span>;
  return (
    <span aria-label={`cost ${cost} of 4`} style={{ display: 'inline-flex', gap: 2 }}>
      {[1, 2, 3, 4].map((i) => <span key={i} style={{ width: 4, height: 10, borderRadius: 1, background: i <= cost ? 'var(--ink-1)' : 'var(--line-strong)' }} />)}
    </span>
  );
}

/**
 * `providerLabel` absent means Anthropic (the server default, and what
 * FALLBACK_MODELS/the inherit row implicitly are) — normalised once here so
 * grouping and the trigger tag never have to re-derive it.
 */
function providerOf(m) {
  return (m && m.providerLabel) || 'Anthropic';
}

/**
 * Splits a flat model list into provider groups, keeping the order providers
 * were first seen in — the server always pushes Anthropic first (the shipped
 * default), so no separate sort is needed here.
 */
function groupByProvider(list) {
  const groups = [];
  for (const m of list) {
    const label = providerOf(m);
    let g = groups.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; groups.push(g); }
    g.items.push(m);
  }
  return groups;
}

/**
 * Model picker for a role. Trigger shows the label; the menu groups rows by
 * provider and lists label, exact model id, a 4-bar cost mark and one line of
 * guidance.
 * `models` normally comes from `GET /models` via `ModelSelect.useModels`; falls back to `FALLBACK_MODELS`.
 */
export function ModelSelect({ align = 'left', value = '', onChange, models, loading, note, inheritNote, allowDefault = true, disabled, style }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(null);
  const root = useRef(null);
  const listRef = useRef(null);
  // "inherits your Claude Code default" is only true on a Claude Code provider.
  // Elsewhere the caller says what Default actually inherits.
  const inherit = inheritNote ? { ...INHERIT, model: inheritNote } : INHERIT;
  const rows = models || FALLBACK_MODELS;
  const list = [...(allowDefault ? [inherit] : []), ...rows];
  const current = list.find((m) => m.id === value) || (value ? { id: value, label: value, model: value } : inherit);
  // Real providers only — the inherit row isn't one of the server's groups
  // and would otherwise show up as its own single-row "Anthropic" bucket.
  const groups = groupByProvider(rows);
  // A single provider (the common case: Anthropic-only, or the fallback list
  // before `/models` answers) gets no headings — grouping earns its screen
  // space only once there's something to distinguish.
  const showHeadings = groups.length > 1;

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (root.current && !root.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => {
    // 20+ rows across several groups means the selection is routinely
    // scrolled out of view on open; find it rather than making someone hunt.
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector('[data-selected="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [open]);

  // A chosen non-default provider must not read like a chosen Anthropic model
  // at a glance — the whole point of this build is that the two now sit side
  // by side in one run. A muted tag names it without competing with the label.
  const currentProvider = providerOf(current);
  const showProviderTag = current.id && currentProvider !== 'Anthropic';

  return (
    <div ref={root} style={{ position: 'relative', display: 'inline-block', ...style }}>
      <button type="button" disabled={disabled || loading} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 150, padding: '6px 8px 6px 10px',
          background: 'var(--bg-card)', border: `1px solid ${open ? 'var(--ink-2)' : 'var(--line-strong)'}`, borderRadius: 'var(--r-sm)',
          color: loading ? 'var(--ink-2)' : 'var(--ink-0)', cursor: disabled || loading ? 'default' : 'pointer', textAlign: 'left',
          transition: 'border-color var(--dur-fast) var(--ease)',
        }}>
        <Icon name={loading ? 'loading' : 'model'} size={14} color="var(--ink-2)" />
        <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {loading ? 'Fetching models…' : current.label}
          </span>
          {showProviderTag && (
            <span style={{
              flex: '0 0 auto', fontSize: 'var(--fs-xs)', lineHeight: 1, padding: '2px 5px', borderRadius: 'var(--r-xs, 3px)',
              background: 'var(--bg-hover)', color: 'var(--ink-2)', border: '1px solid var(--line)',
            }}>{currentProvider}</span>
          )}
        </span>
        <Icon name="chevronDown" size={14} color="var(--ink-2)" />
      </button>
      {open && (
        <div role="listbox" style={{
          // Anchor to whichever edge the trigger sits on. Left-anchored inside a
          // right-aligned settings row, the 300px menu overhangs the modal and
          // gives the whole panel a horizontal scrollbar.
          position: 'absolute', top: 'calc(100% + 4px)', zIndex: 20, minWidth: 300,
          ...(align === 'right' ? { right: 0 } : { left: 0 }),
          background: 'var(--bg-panel)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.28)', padding: 4, display: 'flex', flexDirection: 'column',
        }}>
          {note && (
            // An empty list has a reason — an unreachable endpoint reads very
            // differently from one with nothing installed, and a picker that
            // shows neither leaves the operator guessing.
            <div style={{
              padding: '6px 10px', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
              borderBottom: list.length ? '1px solid var(--line)' : 'none',
            }}>{note}</div>
          )}
          {/* Fixed max height rather than growing with the list: 4 Anthropic +
              10 Ollama + 6 Codex is 20 rows, well past what fits under a
              trigger sitting mid-modal. Scrolls internally; the effect above
              lands on the current selection instead of the top. */}
          <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {allowDefault && (
              <ModelRow key={inherit.id} m={inherit} selected={current.id === inherit.id}
                hover={hover === inherit.id} onHover={setHover}
                onClick={() => { onChange?.(inherit.id, inherit); setOpen(false); }} />
            )}
            {groups.map((g) => (
              <React.Fragment key={g.label}>
                {showHeadings && (
                  <div style={{
                    padding: '6px 8px 4px', marginTop: 2, fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)',
                    color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '0.04em',
                    display: 'flex', justifyContent: 'space-between',
                    // Sticky within the scroll area so a long provider group
                    // doesn't scroll its own heading away mid-read.
                    position: 'sticky', top: 0, background: 'var(--bg-panel)', zIndex: 1,
                  }}>
                    <span>{g.label}</span>
                    <span>{g.items.length}</span>
                  </div>
                )}
                {g.items.map((m) => (
                  <ModelRow key={m.id} m={m} selected={current.id === m.id}
                    hover={hover === m.id} onHover={setHover}
                    onClick={() => { onChange?.(m.id, m); setOpen(false); }} />
                ))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One listbox row. Split out so the inherit row and grouped rows share exactly one layout. */
function ModelRow({ m, selected, hover, onHover, onClick }) {
  return (
    <button type="button" role="option" aria-selected={selected} data-selected={selected || undefined}
      onMouseEnter={() => onHover(m.id)} onMouseLeave={() => onHover(null)}
      onClick={onClick}
      style={{
        display: 'grid', gridTemplateColumns: '14px 1fr auto', columnGap: 10, alignItems: 'start', textAlign: 'left',
        padding: '7px 8px', border: 'none', borderRadius: 4, cursor: 'pointer', color: 'var(--ink-0)',
        background: hover ? 'var(--bg-hover)' : 'transparent', width: '100%',
      }}>
      <span style={{ paddingTop: 2 }}>{selected && <Icon name="check" size={14} color="var(--brand)" />}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: selected ? 'var(--fw-semibold)' : 'inherit' }}>{m.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.model}</span>
        </span>
        {/* `note` is server-written and already carries where it runs and
            what it costs (or that nothing metered applies) — never
            reconstructed here, so an unmetered row can't grow a dollar sign. */}
        {m.note && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{m.note}</span>}
      </span>
      <span style={{ paddingTop: 3 }}><CostMark cost={m.cost} /></span>
    </button>
  );
}
ModelSelect.useModels = useModels;
