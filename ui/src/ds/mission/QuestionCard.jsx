import React, { useState } from 'react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { Textarea } from '../forms/Textarea';

/**
 * The director escalating a decision to the human.
 *
 * When it offered choices, they are buttons — one tap answers, the
 * recommended (first) one marked — and the textarea stays for "something
 * else". The same options reach a phone as inline buttons, so tab and
 * channel offer the identical act.
 */
export function QuestionCard({ question, options = [], value, onChange, onAnswer, style }) {
  const [local, setLocal] = useState('');
  const answer = value ?? local;
  const set = onChange ?? setLocal;
  return (
    <Card accent="var(--brand)" style={{ marginBottom: 'var(--sp-2)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'var(--fw-semibold)', color: 'var(--brand)', fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
        <Icon name="question" size={14} strokeWidth={2} />Director asks:
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-md)' }}>{question}</div>
      {options.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: 'var(--sp-2) 0 0' }}>
          {options.map((o, i) => (
            <button key={o} type="button" onClick={() => onAnswer?.(o)}
              title={i === 0 ? 'Recommended' : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px',
                borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-sm)',
                background: 'var(--bg-inset)', border: '1px solid var(--line-strong)', color: 'var(--ink-0)',
              }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{i + 1}</span>
              {o}
              {i === 0 && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>· recommended</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ margin: 'var(--sp-2) 0' }}>
        <Textarea size="answer" value={answer} onChange={set} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={() => onAnswer?.(answer)} disabled={!String(answer).trim()}>Answer</Button>
      </div>
    </Card>
  );
}
