import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { RichText } from '../core/RichText';
import { Field } from '../forms/Field';
import { TextInput } from '../forms/TextInput';
import { RichEditor } from '../forms/RichEditor';
import { ModelSelect } from '../forms/ModelSelect';
import { Switch } from '../forms/Switch';
import { AttachmentChip } from '../forms/AttachmentChip';
import { Banner } from '../status/Banner';

const PLACEHOLDER = 'Describe the mission…\n\nSay what "done" looks like, name constraints, and flag any decision the director should ask you about before implementing.';

/** Built-in mission templates. Each pre-sets budget and models; the brief has fill-in slots. */
export const MISSION_TEMPLATES = [
  { id: 'bugfix', label: 'Bug fix', icon: 'Bug', budget: 3, director: '', worker: 'sonnet',
    brief: 'Fix: <describe the bug and how to reproduce it>\n\nDone when: the reproduction no longer fails and a regression test covers it.\nConstraints: no unrelated refactors; keep the public API unchanged.\nAsk me before: changing behaviour that other code depends on.' },
  { id: 'tests', label: 'Add tests', icon: 'ListChecks', budget: 4, director: '', worker: 'haiku',
    brief: 'Add tests for: <module or feature>\n\nDone when: each public function has at least one happy-path and one edge-case test, and the suite passes.\nConstraints: use the existing test runner and conventions; no new dependencies.\nAsk me before: changing production code to make it testable.' },
  { id: 'refactor', label: 'Refactor', icon: 'Shuffle', budget: 6, director: 'fable', worker: 'sonnet',
    brief: 'Refactor: <what, and why>\n\nDone when: behaviour is unchanged (existing tests pass), the code is <goal, e.g. split into pure functions>, and nothing outside <scope> is touched.\nConstraints: one concern per commit-sized step; keep diffs reviewable.\nAsk me before: renaming anything exported.' },
  { id: 'audit', label: 'Audit', icon: 'SearchCheck', budget: 2, director: '', worker: 'haiku',
    brief: 'Audit: <area, e.g. error handling / security / accessibility>\n\nDone when: a written report in .foreman/AUDIT.md lists findings ranked by severity with file:line references — no code changes.\nConstraints: read-only; do not modify source files.\nAsk me before: nothing — this mission only reads.' },
];

/** `/Users/you/Projects/a/b/c` → `~/Projects/…/b/c`. Full path stays in the tooltip. */
function shortPath(p) {
  if (!p) return '';
  let s = p.replace(/^\/(Users|home)\/[^/]+/, '~');
  const parts = s.split('/');
  if (parts.length > 4) s = [parts[0], parts[1], '…', ...parts.slice(-2)].join('/');
  return s;
}

function draftKey(folder) { return `foreman:draft:${folder || 'default'}`; }
const fileKey = (f) => `${f.name}:${f.size}`;

/** A single keycap, e.g. ⌘ or ↵, for shortcut hints beside actions. */
function Kbd({ children }) {
  return (
    <kbd style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: 18, height: 18, padding: '0 4px', boxSizing: 'border-box',
      background: 'var(--bg-inset)', border: '1px solid var(--line-strong)',
      borderRadius: 4, color: 'var(--ink-1)',
      fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', lineHeight: 1,
    }}>{children}</kbd>
  );
}

function ToolbarButton({ icon, label, active, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" title={label} aria-label={label} aria-pressed={active} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 24, padding: 0,
        background: active ? 'var(--bg-inset)' : hover ? 'var(--bg-hover)' : 'transparent', border: 'none', borderRadius: 4,
        color: active || hover ? 'var(--ink-0)' : 'var(--ink-2)', cursor: 'pointer',
      }}><Icon name={icon} size={14} /></button>
  );
}

function ModeTab({ icon, label, active, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-selected={active} role="tab" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '0 10px', height: 32, background: 'none', border: 'none',
      borderBottom: `2px solid ${active ? 'var(--brand)' : 'transparent'}`, marginBottom: -1,
      color: active ? 'var(--ink-0)' : 'var(--ink-2)', fontSize: 'var(--fs-sm)', fontWeight: active ? 'var(--fw-semibold)' : 'inherit', cursor: 'pointer',
    }}><Icon name={icon} size={13} />{label}</button>
  );
}

/**
 * The mission composer: templates, an editor frame (Write / Preview, formatting, attachments), a parameter tray, one primary action.
 * Drafts persist per folder (text and settings; attachments are not persisted).
 */
export function Composer({ folder, defaultBudgetUsd = 5, error, busy, templates = MISSION_TEMPLATES, models, modelsLoading, onStart, style }) {
  const stored = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(draftKey(folder)) || 'null'); } catch { return null; }
  }, [folder]);
  const [mission, setMission] = useState(stored?.mission ?? '');
  const [budget, setBudget] = useState(stored?.budget ?? defaultBudgetUsd);
  const [directorModel, setDirectorModel] = useState(stored?.directorModel ?? '');
  const [workerModel, setWorkerModel] = useState(stored?.workerModel ?? '');
  const [browserTools, setBrowserTools] = useState(stored?.browserTools ?? false);
  const [savedAt, setSavedAt] = useState(stored ? 'restored' : null);
  const [mode, setMode] = useState('write');
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const ta = useRef(null);
  const picker = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        if (mission.trim() || stored) {
          localStorage.setItem(draftKey(folder), JSON.stringify({ mission, budget, directorModel, workerModel, browserTools }));
          if (mission.trim()) setSavedAt('saved');
        }
      } catch { /* storage unavailable */ }
    }, 400);
    return () => clearTimeout(id);
  }, [mission, budget, directorModel, workerModel, browserTools, folder]);

  const applyTemplate = (t) => {
    setMission(t.brief); setBudget(t.budget); setDirectorModel(t.director); setWorkerModel(t.worker); setMode('write');
  };
  const clearDraft = () => {
    setMission(''); setFiles([]); setSavedAt(null);
    try { localStorage.removeItem(draftKey(folder)); } catch { /* ignore */ }
  };
  const addFiles = (list) => {
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    setFiles((cur) => { const seen = new Set(cur.map(fileKey)); return [...cur, ...incoming.filter((f) => !seen.has(fileKey(f)))]; });
  };
  const canStart = !busy && mission.trim().length > 0;
  const start = () => { if (canStart) onStart?.({ mission: mission.trim(), budget, directorModel, workerModel, browserTools, attachments: files }); };

  /** Wraps the selection (or inserts a skeleton at the caret) and keeps focus. */
  const wrap = (kind) => {
    const el = ta.current; if (!el) { setMode('write'); return; }
    const s = el.selectionStart ?? mission.length, e = el.selectionEnd ?? s;
    const sel = mission.slice(s, e);
    let out, caret;
    if (kind === 'code') { out = `\`${sel || 'code'}\``; caret = sel ? s + out.length : s + 1; }
    else if (kind === 'quote') { const body = (sel || 'quoted text').split('\n').map((l) => `> ${l}`).join('\n'); out = body; caret = sel ? s + out.length : s + 2; }
    else { const nl = s > 0 && mission[s - 1] !== '\n' ? '\n' : ''; out = `${nl}\`\`\`\n${sel || ''}\n\`\`\`\n`; caret = s + nl.length + 4; }
    const next = mission.slice(0, s) + out + mission.slice(e);
    setMission(next); setMode('write');
    requestAnimationFrame(() => { el.focus(); const end = sel ? caret : caret + (kind === 'code' ? 4 : kind === 'quote' ? 11 : 0); el.setSelectionRange(caret, end); });
  };

  const frameBorder = dragging ? 'var(--brand)' : focused ? 'var(--ink-2)' : 'var(--line-strong)';

  return (
    <div style={{
      maxWidth: 'var(--composer-max)', margin: 'var(--sp-5) auto', padding: '0 var(--sp-4)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style,
    }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>New mission</h2>
        <div title={folder} style={{
          color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{shortPath(folder)}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginRight: 2 }}>
          <Icon name="template" size={12} />Start from
        </span>
        {templates.map((t) => <Button key={t.id} size="sm" icon={t.icon} title={`Budget $${t.budget} · director ${t.director || 'default'} · workers ${t.worker || 'default'}`} onClick={() => applyTemplate(t)}>{t.label}</Button>)}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); if (!dragging) setDragging(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
        style={{
          background: 'var(--bg-card)', border: `1px solid ${frameBorder}`, borderRadius: 'var(--r-md)', overflow: 'hidden',
          boxShadow: dragging ? '0 0 0 3px var(--brand-wash-strong)' : 'none', transition: 'border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)',
        }}>
        <div role="tablist" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 6px', borderBottom: '1px solid var(--line)', background: 'var(--bg-panel)' }}>
          <ModeTab icon="write" label="Write" active={mode === 'write'} onClick={() => setMode('write')} />
          <ModeTab icon="preview" label="Preview" active={mode === 'preview'} onClick={() => setMode('preview')} />
          <span style={{ flex: 1 }} />
          <ToolbarButton icon="quote" label="Quote (> )" onClick={() => wrap('quote')} />
          <ToolbarButton icon="code" label="Inline code (`)" onClick={() => wrap('code')} />
          <ToolbarButton icon="codeBlock" label="Code block (```)" onClick={() => wrap('block')} />
        </div>
        {mode === 'write' ? (
          <RichEditor ref={ta} value={mission} onChange={setMission} placeholder={PLACEHOLDER} minHeight={200} maxHeight={440}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); start(); } }}
            onPaste={(e) => { if (e.clipboardData?.files?.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
        ) : (
          <div style={{ minHeight: 200, maxHeight: 440, overflowY: 'auto', padding: 'var(--sp-3)', boxSizing: 'border-box' }}>
            {mission.trim() ? <RichText text={mission} /> : <span style={{ color: 'var(--ink-2)' }}>Nothing to preview yet.</span>}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 8px', borderTop: '1px solid var(--line)', minHeight: 36, boxSizing: 'border-box' }}>
          <input ref={picker} type="file" multiple style={{ display: 'none' }} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <Button size="sm" variant="ghost" icon="attach" title="Attach files — or drop them on the editor, or paste an image" onClick={() => picker.current?.click()}>Attach</Button>
          {files.map((f, i) => <AttachmentChip key={fileKey(f)} name={f.name} size={f.size} onRemove={() => setFiles((cur) => cur.filter((_, j) => j !== i))} />)}
          <span style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            {savedAt && <><Icon name="draft" size={11} />{savedAt === 'restored' ? 'Draft restored' : 'Draft saved'}</>}
            {(mission || files.length > 0) && <button type="button" onClick={clearDraft} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--ink-2)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}>Clear</button>}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <Field layout="stacked" label="Budget cap" hint="Hard stop; the run halts here.">
          <TextInput type="number" min={1} step={1} width={96} prefix="$" value={budget} onChange={setBudget} />
        </Field>
        <Field layout="stacked" label="Director" hint="Plans, delegates, verifies.">
          <ModelSelect value={directorModel} onChange={setDirectorModel} models={models} loading={modelsLoading} />
        </Field>
        <Field layout="stacked" label="Workers" hint="Implement. Cheaper models cut cost.">
          <ModelSelect value={workerModel} onChange={setWorkerModel} models={models} loading={modelsLoading} />
        </Field>
        <Field label="Browser" hint="Headless Playwright for the agents — navigate, click, screenshot. Non-local URLs still ask you.">
          <Switch checked={browserTools} onChange={setBrowserTools} label={browserTools ? 'on' : 'off'} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        {error && <Banner tone="error" inline style={{ marginRight: 'auto' }}>{error}</Banner>}
        <span title="Start the mission with Cmd+Enter from the editor" style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
        }}>
          <Kbd>⌘</Kbd><Kbd>↵</Kbd>
        </span>
        <Button variant="primary" disabled={!canStart} onClick={start}>Start mission</Button>
      </div>
    </div>
  );
}
