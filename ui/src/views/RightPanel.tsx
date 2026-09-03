import { useState } from 'react';
import { api, type State } from '../state';
import { Button, Card, Empty, SectionTitle } from '../design/ui';

function Approvals({ s }: { s: State }) {
  return (
    <section>
      <SectionTitle>Approvals</SectionTitle>
      {s.approvals.length === 0 && <Empty>No pending approvals.</Empty>}
      {s.approvals.map((a) => (
        <Card key={a.id} accent="var(--brand)" style={{ marginBottom: 'var(--sp-2)' }}>
          <div style={{ fontWeight: 600, color: 'var(--brand)', fontSize: 'var(--fs-sm)' }}>
            [{a.agent}] {a.title ?? `Wants to use ${a.toolName}`}
          </div>
          {a.decisionReason && (
            <div style={{ color: 'var(--status-serious)', fontSize: 'var(--fs-xs)', marginTop: 2 }}>
              △ {a.decisionReason}
            </div>
          )}
          <pre style={{
            background: 'var(--bg-inset)', padding: 'var(--sp-2)', borderRadius: 'var(--r-sm)',
            overflowX: 'auto', fontSize: 'var(--fs-xs)', maxHeight: 150, margin: 'var(--sp-2) 0',
          }}>{JSON.stringify(a.input, null, 2)}</pre>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
            <Button variant="good" onClick={() => api.permission(a.id, 'allow')}>Allow</Button>
            <Button variant="good" onClick={() => api.permission(a.id, 'allow_always')}>Always (run)</Button>
            <Button variant="danger" onClick={() => api.permission(a.id, 'deny')}>Deny</Button>
          </div>
        </Card>
      ))}
    </section>
  );
}

function Questions({ s }: { s: State }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <section>
      <SectionTitle>Questions</SectionTitle>
      {s.questions.length === 0 && <Empty>No questions from the director.</Empty>}
      {s.questions.map((q) => (
        <Card key={q.id} accent="var(--brand)" style={{ marginBottom: 'var(--sp-2)' }}>
          <div style={{ fontWeight: 600, color: 'var(--brand)', fontSize: 'var(--fs-sm)', marginBottom: 4 }}>
            Director asks:
          </div>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--fs-md)' }}>{q.question}</div>
          <textarea
            value={answers[q.id] ?? ''}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            style={{
              width: '100%', height: 56, margin: 'var(--sp-2) 0', resize: 'vertical',
              background: 'var(--bg-inset)', border: '1px solid var(--line-strong)',
              borderRadius: 'var(--r-sm)', padding: 'var(--sp-2)', color: 'var(--ink-0)',
            }} />
          <Button variant="primary" onClick={() => api.answer(q.id, answers[q.id] ?? '')}>Answer</Button>
        </Card>
      ))}
    </section>
  );
}

/** Parse "- [ ]" / "- [x]" items out of MISSION.md into a plan board. */
function parsePlan(doc: string): { text: string; done: boolean }[] {
  return [...doc.matchAll(/^\s*-\s*\[([ xX])\]\s*(.+)$/gm)]
    .map((m) => ({ done: m[1] !== ' ', text: m[2].trim() }));
}

function PlanBoard({ s }: { s: State }) {
  const [raw, setRaw] = useState(false);
  const doc = s.missionDoc;
  const items = doc ? parsePlan(doc) : [];
  const done = items.filter((i) => i.done).length;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
        <SectionTitle>Plan</SectionTitle>
        {items.length > 0 && (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            {done}/{items.length}
          </span>
        )}
        {doc && (
          <button onClick={() => setRaw(!raw)} style={{
            marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--ink-2)', fontSize: 'var(--fs-xs)', textDecoration: 'underline',
          }}>{raw ? 'board' : 'raw doc'}</button>
        )}
      </div>
      {!doc && <Empty>MISSION.md not written yet.</Empty>}
      {doc && !raw && items.map((i, n) => (
        <div key={n} style={{
          display: 'flex', gap: 'var(--sp-2)', padding: '4px 0',
          fontSize: 'var(--fs-sm)', color: i.done ? 'var(--ink-2)' : 'var(--ink-0)',
        }}>
          <span aria-hidden style={{ color: i.done ? 'var(--status-good)' : 'var(--ink-2)' }}>
            {i.done ? '✓' : '○'}
          </span>
          <span style={{ textDecoration: i.done ? 'line-through' : 'none' }}>{i.text}</span>
        </div>
      ))}
      {doc && raw && (
        <pre style={{
          fontSize: 'var(--fs-xs)', whiteSpace: 'pre-wrap', color: 'var(--ink-1)',
          background: 'var(--bg-inset)', borderRadius: 'var(--r-sm)', padding: 'var(--sp-2)',
          maxHeight: 320, overflowY: 'auto',
        }}>{doc}</pre>
      )}
    </section>
  );
}

export function RightPanel({ s }: { s: State }) {
  return (
    <div style={{
      padding: 'var(--sp-3)', overflowY: 'auto', display: 'flex',
      flexDirection: 'column', gap: 'var(--sp-4)',
    }}>
      <Approvals s={s} />
      <Questions s={s} />
      <PlanBoard s={s} />
    </div>
  );
}
