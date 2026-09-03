import React, { useState } from 'react';
import { Card } from '../core/Card';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { Textarea } from '../forms/Textarea';

/** The director escalating a decision to the human. */
export function QuestionCard({ question, value, onChange, onAnswer, style }) {
  const [local, setLocal] = useState('');
  const answer = value ?? local;
  const set = onChange ?? setLocal;
  return (
    <Card accent="var(--brand)" style={{ marginBottom: 'var(--sp-2)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 'var(--fw-semibold)', color: 'var(--brand)', fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
        <Icon name="question" size={14} strokeWidth={2} />Director asks:
      </div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-md)' }}>{question}</div>
      <div style={{ margin: 'var(--sp-2) 0' }}>
        <Textarea size="answer" value={answer} onChange={set} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={() => onAnswer?.(answer)} disabled={!String(answer).trim()}>Answer</Button>
      </div>
    </Card>
  );
}
