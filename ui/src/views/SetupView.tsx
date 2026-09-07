import React, { useEffect, useState } from 'react';
import { api } from '../state';
import { Button } from '../ds/core/Button';
import { Icon } from '../ds/core/Icon';

/**
 * The first-run pages.
 *
 * Shown once, on an install that has nothing linked and nothing run, and
 * again whenever someone opens `#/setup`. Not a form: Foreman has no required
 * choices, and nothing here asks for a key or a token — those keep their
 * write-only homes in Settings. It is a walk through what this machine has,
 * one page per thing, said plainly, with the one action for anything
 * missing. A person who reads it through knows where their missions will
 * run, who pays, whether their phone is in the loop and how far the
 * dashboard reaches — before they link a project and are looking at a
 * planner asking what to do.
 *
 * The no-credentials case is the one this exists for most: a full page that
 * says so, with the three ways forward, and a "check again" that notices a
 * login done in another terminal.
 */

interface Doctor {
  checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string; fix?: string }>;
  auth: { mode: 'api-key' | 'subscription' | 'cloud' | 'none'; source: string; account: { email?: string; org?: string } | null };
  ollama: { host: string; models: number; local: number } | null;
  codex: { models: number } | null;
  tailnet: { dnsName: string | null; ip: string; url: string; https: boolean } | null;
  phone: { label: string | null; bot: string | null } | null;
  browser: { status: 'ok' | 'warn' | 'error'; detail: string; fix?: string } | null;
  version: string;
}

const STEPS = ['Welcome', 'Where missions run', 'Your phone', 'Reach & browser', 'Ready'] as const;

const TONE = {
  ok: { icon: 'done', color: 'var(--status-good)' },
  warn: { icon: 'caution', color: 'var(--status-serious)' },
  none: { icon: 'idle', color: 'var(--ink-2)' },
} as const;

function Fact({ tone, title, children }: { tone: keyof typeof TONE; title: string; children?: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr)', columnGap: 'var(--sp-2)', padding: 'var(--sp-2) 0', borderTop: '1px solid var(--line)' }}>
      <Icon name={t.icon} size={16} color={t.color} style={{ marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ color: 'var(--ink-0)', fontWeight: 'var(--fw-semibold)' }}>{title}</div>
        {children && <div style={{ color: 'var(--ink-1)', marginTop: 2, lineHeight: 'var(--lh)' }}>{children}</div>}
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.92em', background: 'var(--bg-inset)', padding: '1px 5px', borderRadius: 'var(--r-xs, 3px)' }}>{children}</code>;
}

export function SetupView({ onDone, onSettings }: {
  /** Seen through or skipped: remember it and go to the fleet. */
  onDone: () => void;
  onSettings: (section: 'provider' | 'notifications') => void;
}) {
  const [step, setStep] = useState(0);
  const [doc, setDoc] = useState<Doctor | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.doctor();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDoc(await r.json() as Doctor);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  // Re-ask when a page is entered: a login or a link done meanwhile shows.
  useEffect(() => { if (step > 0) void load(); }, [step]);

  const noProvider = doc ? doc.auth.mode === 'none' && !doc.ollama && !doc.codex : false;
  const last = step === STEPS.length - 1;

  const page = (): React.ReactNode => {
    if (step === 0) {
      return (
        <>
          <h1 style={h1}>Foreman runs missions on your projects.</h1>
          <p style={p}>
            You link a folder, talk over what should happen with a planner that reads the code and never changes it,
            and start a mission with a budget. A director plans the work, hires workers, verifies what they did
            and stops at the cap. You approve what matters — from here or from your phone — and read the result:
            the files that changed, the screenshots, the branch, a pull request when you want one.
          </p>
          <p style={p}>
            The next four pages show what this machine has for that. Nothing on them is required; anything missing
            says how to get it.
          </p>
        </>
      );
    }
    if (!doc) return <p style={p}>{err ? `Could not read this machine: ${err}` : 'Reading this machine…'}</p>;
    if (step === 1) {
      const a = doc.auth;
      return (
        <>
          <h1 style={h1}>{noProvider ? 'Nothing to run missions on yet.' : 'Where missions run.'}</h1>
          <p style={p}>
            Missions run through a model provider. By default that is the Claude Code install on this machine, and
            whoever it is signed in as pays. A project can also have a provider of its own.
          </p>
          <div>
            {a.mode === 'subscription' && (
              <Fact tone="ok" title={`Claude Code is signed in${a.account?.email ? ` as ${a.account.email}` : ''}`}>
                Missions bill that subscription{a.account?.org ? ` (${a.account.org})` : ''}. Source: <Code>{a.source}</Code>.
              </Fact>
            )}
            {a.mode === 'api-key' && (
              <Fact tone="ok" title="An Anthropic API key is set in the environment">
                Missions bill that key, per token. Source: <Code>{a.source}</Code>.
              </Fact>
            )}
            {a.mode === 'cloud' && (
              <Fact tone="ok" title={`Claude through ${a.source}`}>Missions bill that cloud account.</Fact>
            )}
            {a.mode === 'none' && (
              <Fact tone="warn" title="Claude Code is not signed in on this machine">
                Until it is, or a project gets a provider of its own, nothing can run. Three ways forward:
                <ol style={{ margin: 'var(--sp-2) 0 0', paddingLeft: '1.2em', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <li>In a terminal, run <Code>claude</Code>, then <Code>/login</Code>. Restart Foreman and press <em>Check again</em>.</li>
                  <li>Start Foreman with <Code>ANTHROPIC_API_KEY</Code> set. The key is billed per token.</li>
                  <li>Link a project, then give it an Anthropic API key, a Codex login or any OpenAI-compatible endpoint in Settings → Provider.</li>
                </ol>
              </Fact>
            )}
            {doc.ollama && (
              <Fact tone="ok" title={`Ollama is running with ${doc.ollama.models} model${doc.ollama.models === 1 ? '' : 's'}`}>
                {doc.ollama.local} served from this machine at no cost per token; the rest are cloud models Ollama proxies.
                They appear in every model picker.
              </Fact>
            )}
            {doc.codex && (
              <Fact tone="ok" title={`Codex is signed in, ${doc.codex.models} model${doc.codex.models === 1 ? '' : 's'}`}>
                Runs on the ChatGPT subscription. In every model picker as well.
              </Fact>
            )}
            {!doc.ollama && !doc.codex && a.mode !== 'none' && (
              <Fact tone="none" title="No local Ollama or Codex">
                Not needed. If either is installed later, its models show up in the pickers on their own.
              </Fact>
            )}
          </div>
        </>
      );
    }
    if (step === 2) {
      const ph = doc.phone;
      return (
        <>
          <h1 style={h1}>Your phone.</h1>
          <p style={p}>
            Foreman can reach you on Telegram: an approval to tap, a question to answer, a mission that finished,
            a budget alert. From there you can also talk to the front desk and start planning. Optional, and the
            bot token is only ever typed into Settings.
          </p>
          <div>
            {ph?.label && <Fact tone="ok" title={`Linked to ${ph.label}`}>Through {ph.bot ? <Code>@{ph.bot.replace(/^@/, '')}</Code> : 'your bot'}.</Fact>}
            {ph && !ph.label && <Fact tone="warn" title="A bot is configured but no chat is linked yet">Send it <Code>/start</Code> from your phone to link this chat.</Fact>}
            {!ph && (
              <Fact tone="none" title="Not set up">
                Create a bot with @BotFather, paste its token in Settings → Notifications, then send it <Code>/start</Code>.
              </Fact>
            )}
          </div>
          <div><Button variant="ghost" size="sm" icon="needsYou" onClick={() => onSettings('notifications')}>Settings → Notifications</Button></div>
        </>
      );
    }
    if (step === 3) {
      const t = doc.tailnet; const b = doc.browser;
      return (
        <>
          <h1 style={h1}>Reach, and a browser for the crew.</h1>
          <div>
            {t ? (
              <Fact tone="ok" title={`On a tailnet: ${t.dnsName ?? t.ip}`}>
                The dashboard is also at <Code>{t.url}</Code>{t.https ? ', over HTTPS' : ''}. Phone links open there.
                {!t.https && <> For HTTPS, <Code>tailscale serve</Code> can front it; Foreman never opens a Funnel.</>}
              </Fact>
            ) : (
              <Fact tone="none" title="This machine only">
                The dashboard listens on localhost. With Tailscale installed it also listens on the tailnet, so the
                phone can open links; nothing is ever exposed to the internet.
              </Fact>
            )}
            {b && (
              <Fact tone={b.status === 'ok' ? 'ok' : 'warn'} title={b.status === 'ok' ? 'A browser for missions' : 'No browser for missions'}>
                {b.detail}{b.fix && b.status !== 'ok' ? <><br />{b.fix}</> : null}
                {b.status !== 'ok' && <><br />Missions that do not need a browser are unaffected.</>}
              </Fact>
            )}
          </div>
        </>
      );
    }
    const a = doc.auth;
    return (
      <>
        <h1 style={h1}>{noProvider ? 'Set up, minus a provider.' : 'Ready.'}</h1>
        <div>
          <Fact tone={a.mode === 'none' ? (doc.ollama || doc.codex ? 'warn' : 'warn') : 'ok'} title="Missions run on">
            {a.mode === 'none' ? 'nothing yet — see page 2' : a.mode === 'subscription' ? `Claude Code${a.account?.email ? `, ${a.account.email}` : ''}` : a.mode === 'api-key' ? 'an Anthropic API key' : a.source}
            {doc.ollama ? ` · Ollama, ${doc.ollama.models} models` : ''}{doc.codex ? ' · Codex' : ''}
          </Fact>
          <Fact tone={doc.phone?.label ? 'ok' : 'none'} title="Phone">{doc.phone?.label ? `Telegram, ${doc.phone.label}` : 'not linked'}</Fact>
          <Fact tone={doc.tailnet ? 'ok' : 'none'} title="Reach">{doc.tailnet ? `localhost and ${doc.tailnet.dnsName ?? doc.tailnet.ip}` : 'localhost'}</Fact>
          <Fact tone={doc.browser?.status === 'ok' ? 'ok' : 'warn'} title="Browser">{doc.browser?.status === 'ok' ? 'found' : 'none — browser missions will fail'}</Fact>
        </div>
        <p style={p}>
          Next: link a project — a folder on this machine, or a Git URL to clone. The fleet page has the card;
          dropping a folder anywhere on it works too. This walk-through is at <Code>#/setup</Code> whenever you want it,
          and <Code>foreman doctor</Code> says the same in a terminal.
        </p>
      </>
    );
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg-app)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ width: '100%', maxWidth: '44rem', margin: '0 auto', padding: '56px var(--sp-4) 40px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', flex: 1 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
          <span style={{ fontWeight: 'var(--fw-semibold)' }}>Foreman</span>
          <span style={{ color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>first run{doc?.version ? ` · v${doc.version}` : ''}</span>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" onClick={onDone}>Skip to the fleet</Button>
        </header>

        {/* The steps: numbered because they are a sequence, and the number is
            the reader's place in it. Any earlier one is a click back. */}
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          {STEPS.map((label, i) => {
            const state = i < step ? 'done' : i === step ? 'now' : 'todo';
            return (
              <li key={label}>
                <button type="button" onClick={() => i < step && setStep(i)} disabled={i > step}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: '4px 6px',
                    font: 'inherit', fontSize: 'var(--fs-sm)', cursor: i < step ? 'pointer' : 'default',
                    color: state === 'now' ? 'var(--ink-0)' : state === 'done' ? 'var(--ink-1)' : 'var(--ink-2)',
                    fontWeight: state === 'now' ? 'var(--fw-semibold)' : 'inherit',
                  }}>
                  <span style={{
                    width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--fs-xs)', fontVariantNumeric: 'tabular-nums',
                    background: state === 'now' ? 'var(--brand)' : state === 'done' ? 'var(--status-good)' : 'transparent',
                    color: state === 'todo' ? 'var(--ink-2)' : 'var(--brand-ink)', border: state === 'todo' ? '1px solid var(--line-strong)' : '1px solid transparent',
                  }}>{state === 'done' ? <Icon name="done" size={11} /> : i + 1}</span>
                  {label}
                </button>
              </li>
            );
          })}
        </ol>

        <section style={{ background: 'var(--bg-card)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', fontSize: 'var(--fs-md, var(--fs-sm))' }}>
          {page()}
        </section>

        <footer style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          {step > 0 && <Button variant="ghost" icon="back" onClick={() => setStep(step - 1)}>Back</Button>}
          <span style={{ flex: 1 }} />
          {step > 0 && <Button variant="ghost" icon={busy ? 'loading' : 'resume'} disabled={busy} onClick={() => void load()}>Check again</Button>}
          {last
            ? <Button variant="primary" icon="add" onClick={onDone}>Go link a project</Button>
            : <Button variant="primary" onClick={() => setStep(step + 1)}>{step === 0 ? 'Show me' : step === 1 && noProvider ? 'Continue without a provider' : 'Continue'}</Button>}
        </footer>
      </div>
    </div>
  );
}

const h1: React.CSSProperties = { margin: 0, fontSize: 'var(--fs-xl, 1.35rem)', fontWeight: 'var(--fw-semibold)', lineHeight: 1.25, textWrap: 'balance' as never };
const p: React.CSSProperties = { margin: 0, color: 'var(--ink-1)', lineHeight: 'var(--lh)', maxWidth: '62ch' };
