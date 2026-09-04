import { useEffect, useState } from 'react';
import { api, type ClaudeInstancePin, type ProjectSummary } from '../state';
import { Button, SectionTitle } from '../design/ui';

type Discovered = { configDir: string; origin: string; hasStoredLogin: boolean };
type InstancesInfo = {
  serverDefault: ClaudeInstancePin;
  authMode: 'api-key' | 'subscription' | 'cloud' | 'none';
  keychainLogin: boolean;
  instances: Discovered[];
};

/** Sentinels for the two non-path choices. */
const INHERIT = '';
const CUSTOM = ' custom';

/**
 * Project settings. Today: which Claude Code install this project's missions run
 * under, plus the default budget. This is the surface section 5 of the design
 * system reserved for per-project presets — models and trusted tools land here
 * next. It also gives `unlink` a confirm (UX debt #8).
 */
export function ProjectSettings({ p, onClose, onSaved, onUnlink }: {
  p: ProjectSummary; onClose: () => void; onSaved: () => void; onUnlink: () => void;
}) {
  const [info, setInfo] = useState<InstancesInfo | null>(null);
  const [choice, setChoice] = useState<string>(p.claudeInstance?.configDir ?? INHERIT);
  const [customDir, setCustomDir] = useState(p.claudeInstance?.configDir ?? '');
  const [ownLogin, setOwnLogin] = useState(p.claudeInstance?.billing === 'own-login');
  const [budget, setBudget] = useState(p.defaultBudgetUsd);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.instances().then(async (r) => {
      if (!r.ok) return;
      const data: InstancesInfo = await r.json();
      setInfo(data);
      // A pin pointing somewhere undiscovered is still valid — show it as custom.
      const pinned = p.claudeInstance?.configDir;
      if (pinned && !data.instances.some((i) => i.configDir === pinned)) setChoice(CUSTOM);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const configDir = choice === INHERIT ? '' : choice === CUSTOM ? customDir.trim() : choice;
  /** Billing only has meaning once a specific install is chosen. */
  const pinned = choice !== INHERIT;
  const selected = info?.instances.find((i) => i.configDir === configDir);

  const save = async () => {
    setErr('');
    setBusy(true);
    // Both fields are always sent; '' clears the pin server-side.
    const r = await api.updateProject(p.id, {
      claudeConfigDir: configDir,
      claudeBilling: pinned && ownLogin ? 'own-login' : 'inherit',
      defaultBudgetUsd: budget,
    }).finally(() => setBusy(false));
    if (!r.ok) setErr((await r.json()).error ?? 'could not save');
    else { onSaved(); onClose(); }
  };

  const serverDefaultHint = info?.serverDefault.configDir ?? 'inherited from the server process';

  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 10,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
        background: 'var(--bg-panel)', border: '1px solid var(--line-strong)',
        borderRadius: 'var(--r-md)', overflow: 'hidden',
      }}>
        <div style={{ padding: 'var(--sp-3)', borderBottom: '1px solid var(--line)' }}>
          <div style={{ fontWeight: 600 }}>Project settings</div>
          <div style={{
            fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
            fontFamily: 'var(--font-mono)', wordBreak: 'break-all',
          }}>{p.folder}</div>
        </div>

        <div style={{
          overflowY: 'auto', padding: 'var(--sp-3)',
          display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)',
        }}>
          <section>
            <SectionTitle>Claude Code instance</SectionTitle>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <InstanceRow selected={choice === INHERIT} onSelect={() => setChoice(INHERIT)}
                label="Server default" hint={serverDefaultHint} />
              {info?.instances.map((i) => (
                <InstanceRow key={i.configDir} mono
                  selected={choice === i.configDir} onSelect={() => setChoice(i.configDir)}
                  label={i.configDir}
                  hint={`${i.origin} - ${i.hasStoredLogin ? 'stored login' : 'no stored login'}`} />
              ))}
              <InstanceRow selected={choice === CUSTOM} onSelect={() => setChoice(CUSTOM)}
                label="Custom path..." hint="Any CLAUDE_CONFIG_DIR on this machine" />
            </div>

            {choice === CUSTOM && (
              <input autoFocus value={customDir} placeholder="~/.claude-work"
                onChange={(e) => setCustomDir(e.target.value)}
                style={{ ...inputStyle, marginTop: 'var(--sp-2)', fontFamily: 'var(--font-mono)' }} />
            )}

            {info?.authMode === 'api-key' && !ownLogin && (
              <div style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
                <span aria-hidden>&#9727; </span>
                An API key is set in the server environment, so it bills every mission whichever
                instance is chosen here. The instance still selects settings, plugins, and CLAUDE.md.
              </div>
            )}
          </section>

          {pinned && (
            <section>
              <SectionTitle>Billing</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <InstanceRow selected={!ownLogin} onSelect={() => setOwnLogin(false)}
                  label="Inherit server billing"
                  hint={info?.authMode === 'api-key' ? 'the server API key pays' : 'whatever the server uses'} />
                <InstanceRow selected={ownLogin} onSelect={() => setOwnLogin(true)}
                  label="Use this instance's own login"
                  hint="drops the server's API key for this project" />
              </div>
              {ownLogin && selected && !selected.hasStoredLogin && (
                <div style={{ marginTop: 'var(--sp-2)', fontSize: 'var(--fs-xs)', color: 'var(--status-critical)' }}>
                  <span aria-hidden>&#9888; </span>
                  That instance has no stored login, so missions would have no credentials at all.
                  Sign in to it with Claude Code first.
                </div>
              )}
            </section>
          )}

          <section>
            <SectionTitle>Defaults</SectionTitle>
            <label style={{
              display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
              fontSize: 'var(--fs-sm)', color: 'var(--ink-1)',
            }}>
              Budget $
              <input type="number" min={1} step={1} value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                style={{ ...inputStyle, width: 90 }} />
            </label>
          </section>

          <section style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--sp-3)' }}>
            <SectionTitle>Danger zone</SectionTitle>
            {confirmUnlink ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)' }}>
                  Unlink {p.name}? Run history is kept; the folder is untouched.
                </span>
                <span style={{ flex: 1 }} />
                <Button onClick={() => setConfirmUnlink(false)}>Cancel</Button>
                <Button variant="danger" onClick={onUnlink}>Unlink</Button>
              </div>
            ) : (
              <Button variant="danger" onClick={() => setConfirmUnlink(true)}>Unlink project</Button>
            )}
          </section>
        </div>

        {err && (
          <div style={{ padding: '4px var(--sp-3)', color: 'var(--status-critical)', fontSize: 'var(--fs-xs)' }}>
            <span aria-hidden>&#10005; </span>{err}
          </div>
        )}

        <div style={{
          display: 'flex', gap: 'var(--sp-2)', padding: 'var(--sp-3)',
          borderTop: '1px solid var(--line)', alignItems: 'center',
        }}>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || (choice === CUSTOM && !customDir.trim())}
            onClick={() => void save()}>
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** One selectable install. Selection carries an icon, never colour alone. */
function InstanceRow({ selected, onSelect, label, hint, mono }: {
  selected: boolean; onSelect: () => void; label: string; hint: string; mono?: boolean;
}) {
  return (
    <div role="button" onClick={onSelect} style={{
      display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)',
      padding: '7px 9px', borderRadius: 'var(--r-sm)', cursor: 'pointer',
      background: selected ? 'var(--bg-card)' : 'transparent',
      border: `1px solid ${selected ? 'var(--line-strong)' : 'transparent'}`,
    }}>
      <span aria-hidden style={{ color: selected ? 'var(--ink-0)' : 'var(--ink-2)', width: 12 }}>
        {selected ? '✓' : '○'}
      </span>
      <span style={{
        color: 'var(--ink-0)', fontSize: 'var(--fs-sm)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit',
      }}>{label}</span>
      <span style={{ marginLeft: 'auto', color: 'var(--ink-2)', fontSize: 'var(--fs-xs)' }}>{hint}</span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--line-strong)',
  borderRadius: 'var(--r-sm)', padding: '6px 9px', color: 'var(--ink-0)', width: '100%',
};
