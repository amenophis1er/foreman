import React, { useState, useRef, useEffect } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { Tabs } from '../core/Tabs';
import { AgentDot } from '../status/AgentDot';

const TIMING = [
  { value: 'next', label: 'Next turn', icon: 'nextTurn' },
  { value: 'now', label: 'Now', icon: 'now' },
];

/**
 * Unsolicited guidance while a run is live. Docked under the transcript; the message lands in the transcript as a `steer` entry.
 * `next` queues the note for the agent's next turn; `now` interrupts the current tool call and injects it immediately.
 */
export function SteerBar({ agents = [], to, onTo, value, onChange, timing, onTiming, onSend, disabled, disabledReason, style }) {
  const [localText, setLocalText] = useState('');
  const [localTo, setLocalTo] = useState('director');
  const [localTiming, setLocalTiming] = useState('next');
  const [menu, setMenu] = useState(false);
  const [focus, setFocus] = useState(false);
  const ta = useRef(null);
  const root = useRef(null);

  const text = value ?? localText;
  const setText = onChange ?? setLocalText;
  const recipient = to ?? localTo;
  const setRecipient = onTo ?? setLocalTo;
  const when = timing ?? localTiming;
  const setWhen = onTiming ?? setLocalTiming;

  const live = agents.filter((a) => a.status === 'running' || a.id === 'director');
  const canSend = !disabled && text.trim().length > 0;

  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 132) + 'px';
  }, [text]);

  useEffect(() => {
    if (!menu) return;
    const close = (e) => { if (root.current && !root.current.contains(e.target)) setMenu(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const send = () => {
    if (!canSend) return;
    onSend?.(text.trim(), { to: recipient, timing: when });
    setText('');
  };

  return (
    <div ref={root} style={{
      position: 'relative', flex: '0 0 auto',
      background: 'var(--bg-card)', border: `1px solid ${focus ? 'var(--brand)' : 'var(--line-strong)'}`,
      borderRadius: 'var(--r-md)', padding: 'var(--sp-2) var(--sp-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)',
      opacity: disabled ? 0.6 : 1,
      transition: 'border-color var(--dur-fast) var(--ease)', ...style,
    }}>
      <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'flex-start' }}>
        <Icon name="steer" size={15} color="var(--brand)" style={{ marginTop: 3, flex: '0 0 auto' }} />
        <textarea ref={ta} rows={1} value={text} disabled={disabled}
          placeholder={disabled ? (disabledReason || 'Nothing is running.') : `Steer ${recipient}… a constraint, a correction, a hint. Not a question reply.`}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }}
          style={{
            flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', lineHeight: 'var(--lh)', padding: '2px 0', maxHeight: 132,
          }} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <RecipientChip agent={recipient} open={menu} onClick={() => !disabled && setMenu((m) => !m)} disabled={disabled} />
        <Tabs size="sm" tabs={TIMING} value={when} onChange={setWhen} />
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
          {when === 'now' ? 'Interrupts the current tool call' : 'Delivered before the next tool call'}
        </span>
        <Button size="sm" icon="send" onClick={send} disabled={!canSend} title="⌘↵">Send</Button>
      </div>
      {menu && (
        <div role="listbox" style={{
          position: 'absolute', left: 'var(--sp-3)', bottom: 'calc(100% - 4px)', zIndex: 10, minWidth: 220,
          background: 'var(--bg-panel)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)',
          boxShadow: 'var(--shadow-pop, 0 8px 24px rgba(0,0,0,.35))', padding: 4,
        }}>
          {live.map((a) => (
            <Row key={a.id} agent={a} selected={a.id === recipient} onSelect={() => { setRecipient(a.id); setMenu(false); ta.current?.focus(); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecipientChip({ agent, open, onClick, disabled }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px 3px 6px',
        borderRadius: 'var(--r-pill)', border: '1px solid var(--line)', cursor: disabled ? 'default' : 'pointer',
        background: open || hover ? 'var(--bg-hover)' : 'var(--bg-inset)', color: 'var(--ink-0)',
        font: 'inherit', fontSize: 'var(--fs-xs)',
      }}>
      <span style={{ color: 'var(--ink-2)' }}>to</span>
      <AgentDot agent={agent} size="sm" />
      <span style={{ fontFamily: 'var(--font-mono)' }}>{agent}</span>
      <Icon name="chevronDown" size={12} color="var(--ink-2)" />
    </button>
  );
}

function Row({ agent, selected, onSelect }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" role="option" aria-selected={selected} onClick={onSelect}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '6px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', font: 'inherit',
        background: hover ? 'var(--bg-hover)' : 'transparent', color: 'var(--ink-0)',
      }}>
      <span style={{ width: 12, display: 'inline-flex', color: 'var(--brand)' }}>{selected && <Icon name="check" size={12} strokeWidth={2.5} />}</span>
      <AgentDot agent={agent.id} size="sm" />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{agent.id}</span>
      {agent.task && <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.task}</span>}
    </button>
  );
}
