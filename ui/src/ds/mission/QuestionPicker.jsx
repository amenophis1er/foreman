import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/**
 * The planner asked something with a small set of sensible answers. This
 * takes the input box's slot and turns the answer into a click.
 *
 * Why it replaces the bar instead of sitting above it: right now the question
 * IS the input. Two ways to reply to the same thing side by side would be a
 * real question about which one to use. Typing is still possible — the free
 * text line at the bottom of the last question is the same textarea the bar
 * had, and the server routes anything typed to the waiting question.
 *
 * Speed rules, in order of how often they matter:
 *  - One single-choice question: clicking an option answers immediately. No
 *    confirm step for the common case.
 *  - Several questions, or a multi-select: pick per question, then one Send.
 *    Each question shows a check once it has a value, so a half-answered
 *    stack is obvious at a glance.
 *  - Keyboard: digits 1–9 pick an option in the focused question, Enter sends
 *    when everything is answered, ⌘↵ sends free text.
 *  - The recommended option is whichever the planner listed first; it is
 *    marked, not preselected, so a default is never sent by accident.
 */
export function QuestionPicker({ questions = [], askedAt, who, onAnswer, onFreeText, style }) {
  const [picked, setPicked] = useState({});   // question -> label | label[]
  const [text, setText] = useState('');
  const [focusQ, setFocusQ] = useState(0);
  const [sent, setSent] = useState(false);
  const rootRef = useRef(null);

  const single = questions.length === 1 && !questions[0]?.multi;
  const allAnswered = questions.every((q) => {
    const v = picked[q.question];
    return Array.isArray(v) ? v.length > 0 : Boolean(v);
  });

  // A new question batch arrives with a new object identity; reset local
  // state so a previous batch's picks never leak into this one.
  useEffect(() => { setPicked({}); setText(''); setFocusQ(0); setSent(false); }, [questions]);

  const answersOut = useMemo(() => {
    const out = {};
    for (const q of questions) {
      const v = picked[q.question];
      if (Array.isArray(v)) out[q.question] = v.join(', ');
      else if (v) out[q.question] = v;
    }
    return out;
  }, [picked, questions]);

  const submit = (answers) => {
    if (sent) return;
    setSent(true);
    onAnswer?.(answers);
  };

  const choose = (q, label) => {
    if (sent) return;
    if (q.multi) {
      setPicked((p) => {
        const cur = Array.isArray(p[q.question]) ? p[q.question] : [];
        const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label];
        return { ...p, [q.question]: next };
      });
      return;
    }
    const next = { ...picked, [q.question]: label };
    setPicked(next);
    // The common case is one fork: answer it on the click, no confirm step.
    if (single) submit({ [q.question]: label });
  };

  const sendFree = () => {
    const t = text.trim();
    if (!t || sent) return;
    // Free text answers the focused question if there are several; with one
    // question it simply is the answer. Anything else picked comes along.
    const q = questions[Math.min(focusQ, questions.length - 1)];
    const answers = { ...answersOut, [q.question]: t };
    if (questions.length === 1) { setSent(true); onAnswer?.(answers); return; }
    // Several questions and a typed answer for one of them: send what we have
    // for all of them, so the planner is not left waiting on the rest.
    setSent(true); onAnswer?.(answers);
  };

  const onKeyDown = (e) => {
    if (e.target.tagName === 'TEXTAREA') {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendFree(); }
      return;
    }
    const q = questions[focusQ];
    if (!q) return;
    if (/^[1-9]$/.test(e.key)) {
      const opt = q.options[Number(e.key) - 1];
      if (opt) { e.preventDefault(); choose(q, opt.label); }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault(); setFocusQ((i) => Math.min(questions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); setFocusQ((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && !single && allAnswered) {
      e.preventDefault(); submit(answersOut);
    }
  };

  const waited = askedAt ? Math.max(0, Math.round((Date.now() - askedAt) / 60000)) : 0;

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} style={{
      flex: '0 0 auto', outline: 'none',
      background: 'var(--bg-card)', border: '1px solid var(--brand)',
      borderRadius: 'var(--r-md)', overflow: 'hidden',
      opacity: sent ? 0.6 : 1, transition: 'opacity var(--dur-fast) var(--ease)', ...style,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)', borderBottom: '1px solid var(--line)',
        fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
      }}>
        <Icon name="question" size={14} color="var(--brand)" />
        <span style={{ color: 'var(--ink-1)', fontWeight: 'var(--fw-semibold)' }}>The foreman asks</span>
        <span>· pick an answer, or type one</span>
        {waited >= 1 && <span style={{ marginLeft: 'auto' }}>waiting {waited}m</span>}
      </div>

      {questions.map((q, qi) => {
        const v = picked[q.question];
        const done = Array.isArray(v) ? v.length > 0 : Boolean(v);
        const focused = qi === focusQ;
        return (
          <div key={q.question} onMouseEnter={() => setFocusQ(qi)} style={{
            padding: 'var(--sp-2) var(--sp-3)',
            borderBottom: '1px solid var(--line)',
            background: focused && questions.length > 1 ? 'var(--bg-inset)' : 'transparent',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6, fontSize: 'var(--fs-md)', color: 'var(--ink-0)' }}>
              {questions.length > 1 && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: done ? 'var(--status-ok, var(--brand))' : 'var(--ink-2)' }}>
                  {done ? '✓' : `${qi + 1}.`}
                </span>
              )}
              <span>{q.question}</span>
              {q.multi && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>choose any</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {q.options.map((o, oi) => {
                const on = Array.isArray(v) ? v.includes(o.label) : v === o.label;
                return (
                  <button key={o.label} type="button" disabled={sent}
                    onClick={() => choose(q, o.label)}
                    title={o.hint || (oi === 0 ? 'Recommended' : undefined)}
                    style={{
                      display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                      padding: '6px 10px', borderRadius: 'var(--r-sm)', cursor: sent ? 'default' : 'pointer',
                      font: 'inherit', textAlign: 'left', maxWidth: 360,
                      background: on ? 'color-mix(in srgb, var(--brand) 16%, transparent)' : 'var(--bg-inset)',
                      border: `1px solid ${on ? 'var(--brand)' : 'var(--line-strong)'}`,
                      color: on ? 'var(--brand)' : 'var(--ink-0)',
                      transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease)',
                    }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)' }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', minWidth: 14,
                        color: on ? 'var(--brand)' : 'var(--ink-2)',
                      }}>{oi + 1}</span>
                      {o.label}
                      {oi === 0 && (
                        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontWeight: 'var(--fw-normal)' }}>
                          · recommended
                        </span>
                      )}
                    </span>
                    {o.hint && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>{o.hint}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--sp-2)', padding: 'var(--sp-2) var(--sp-3)' }}>
        <textarea rows={1} value={text} disabled={sent}
          placeholder={questions.length > 1 ? `Something else for question ${focusQ + 1}…` : 'Something else…'}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => { /* keep focusQ */ }}
          style={{
            flex: 1, minWidth: 0, resize: 'none', border: 'none', outline: 'none', background: 'transparent',
            color: 'var(--ink-0)', font: 'inherit', lineHeight: 'var(--lh)', padding: '4px 0',
          }} />
        {text.trim() ? (
          <Button size="sm" icon="send" onClick={sendFree} disabled={sent} title="⌘↵">Send</Button>
        ) : !single ? (
          <Button size="sm" variant="primary" onClick={() => submit(answersOut)} disabled={sent || !allAnswered}
            title={allAnswered ? 'Enter' : 'Answer every question first'}>
            Send answers
          </Button>
        ) : null}
      </div>
      {who && (
        <div style={{ padding: '0 var(--sp-3) var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>
          {who.model} · {String(who.provider).split(' · ')[0]}
        </div>
      )}
    </div>
  );
}
