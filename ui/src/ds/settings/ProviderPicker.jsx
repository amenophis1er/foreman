import React, { useState } from 'react';
import { Tabs } from '../core/Tabs';
import { TextInput } from '../forms/TextInput';
import { Switch } from '../forms/Switch';
import { Icon } from '../core/Icon';
import { shortPath } from '../core/path';

const KIND_TABS = [
  { value: 'default', label: 'Server default' },
  { value: 'claude-code', label: 'Claude Code', icon: 'model' },
  { value: 'anthropic-api', label: 'Anthropic API', icon: 'budget' },
  { value: 'codex', label: 'Codex', icon: 'Bash' },
  { value: 'openai-compatible', label: 'Custom endpoint', icon: 'WebFetch' },
];

/** A fresh, minimal value for a kind — never fields carried over from another
 *  kind. That is the whole point of the union: "subscription login + custom
 *  base URL" must not be constructible by clicking through the tabs. */
function blank(kind) {
  switch (kind) {
    case 'claude-code': return { kind };
    case 'anthropic-api': return { kind, apiKeyEnv: '' };
    case 'codex': return { kind };
    case 'openai-compatible': return { kind, baseUrl: '' };
    default: return null;
  }
}

/** `apiKeyEnv` names a variable in the server's own environment. There is no
 *  secret store yet, so the row must say that outright rather than look like
 *  a place to paste a key — see docs/provider-model-tracker.md Cross-cutting. */
function EnvVarHint() {
  return (
    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginTop: 4 }}>
      Names an environment variable on the server; a paste-a-key store is coming.
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{label}</span>
      {children}
    </label>
  );
}

/** One discovered Claude Code install, offered as a click instead of a path
 *  to type. Selected state mirrors `value.configDir` exactly (including both
 *  being undefined, for "server default install"). */
function InstanceOption({ inst, selected, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', width: '100%',
        padding: '6px 8px', borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit',
        background: selected ? 'var(--brand-wash-strong)' : hover ? 'var(--bg-hover)' : 'transparent',
        border: `1px solid ${selected ? 'var(--brand)' : 'var(--line)'}`,
      }}>
      <Icon name="model" size={13} color={selected ? 'var(--brand)' : 'var(--ink-2)'} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inst.configDir}>
        {shortPath(inst.configDir)}
      </span>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{inst.origin}</span>
      {inst.hasStoredLogin && <span title="Has a stored login" style={{ width: 6, height: 6, borderRadius: 'var(--r-pill)', background: 'var(--status-good)', flex: '0 0 auto' }} />}
    </button>
  );
}

/**
 * Edits one `ProviderRef`: which engine drives a project's agents, who pays,
 * where requests go. See docs/provider-model.md §1 — engine, credential and
 * wire travel together as one discriminated union, never three independent
 * fields, so a picker that let you mix them would let you configure the exact
 * combination the type exists to forbid.
 *
 * Switching the kind tab always replaces the value with a blank one for that
 * kind (see `blank()`); editing a field within a kind patches in place. The
 * keyless kinds — a Claude Code install, Ollama, a Codex install — are the
 * ones that work with nothing further configured, so they get one-click
 * choices from `instances` / `ollama`. The keyed kinds only ever collect an
 * environment variable *name*; there is no secret store yet, so the row says
 * that instead of pretending a pasted key would go anywhere.
 */
export function ProviderPicker({ value, onChange, instances, ollama, style }) {
  const [advanced, setAdvanced] = useState(false);
  const kind = value?.kind ?? 'default';

  const patch = (fields) => onChange({ ...value, ...fields });
  const selectKind = (next) => onChange(blank(next));

  const usingOllama = kind === 'openai-compatible' && ollama && value.baseUrl === ollama.host;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', ...style }}>
      <Tabs size="sm" value={kind} onChange={selectKind} tabs={KIND_TABS} />

      {kind === 'default' && (
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
          Runs on whatever the server itself authenticates as.
        </div>
      )}

      {kind === 'claude-code' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          {instances?.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {instances.map((inst) => (
                <InstanceOption key={inst.configDir} inst={inst}
                  selected={(value.configDir ?? '') === inst.configDir}
                  onClick={() => patch({ configDir: inst.configDir })} />
              ))}
            </div>
          )}
          <Field label="Config dir (blank inherits the server's own install)">
            <TextInput mono placeholder="~/.claude-work" value={value.configDir ?? ''}
              onChange={(v) => patch({ configDir: v || undefined })} />
          </Field>
          {advanced ? (
            <Field label="Executable (blank uses the SDK's bundled one)">
              <TextInput mono placeholder="/usr/local/bin/claude" value={value.executable ?? ''}
                onChange={(v) => patch({ executable: v || undefined })} />
            </Field>
          ) : (
            <button type="button" onClick={() => setAdvanced(true)}
              style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
              Pin an executable too
            </button>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Switch checked={!!value.ownLogin} onChange={(v) => patch({ ownLogin: v || undefined })} />
            <span style={{ fontSize: 'var(--fs-sm)' }}>Own login</span>
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            Strips any inherited API key from this project's agents so this install's own stored subscription pays, instead of whatever the server process authenticates as.
          </div>
        </div>
      )}

      {kind === 'anthropic-api' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <Field label="Environment variable">
            <TextInput mono placeholder="ANTHROPIC_API_KEY_ALPHA" value={value.apiKeyEnv ?? ''}
              onChange={(v) => patch({ apiKeyEnv: v })} />
          </Field>
          <EnvVarHint />
          <Field label="Model (blank uses the provider's default)">
            <TextInput mono placeholder="claude-sonnet-4-5" value={value.model ?? ''}
              onChange={(v) => patch({ model: v || undefined })} />
          </Field>
        </div>
      )}

      {kind === 'codex' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
            Reads the login `codex login` already stored — Foreman never mints its own token.
          </div>
          <Field label="Codex home (blank is ~/.codex)">
            <TextInput mono placeholder="~/.codex" value={value.codexHome ?? ''}
              onChange={(v) => patch({ codexHome: v || undefined })} />
          </Field>
          {advanced ? (
            <Field label="Upstream URL (blank is the public ChatGPT backend)">
              <TextInput mono placeholder="https://chatgpt.com/backend-api/codex" value={value.upstreamUrl ?? ''}
                onChange={(v) => patch({ upstreamUrl: v || undefined })} />
            </Field>
          ) : (
            <button type="button" onClick={() => setAdvanced(true)}
              style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>
              Point at a different upstream
            </button>
          )}
          <Field label="Model (blank uses Codex's own default)">
            <TextInput mono placeholder="gpt-5-codex" value={value.model ?? ''}
              onChange={(v) => patch({ model: v || undefined })} />
          </Field>
        </div>
      )}

      {kind === 'openai-compatible' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          {ollama && (
            <button type="button" onClick={() => patch({ baseUrl: ollama.host, label: 'Ollama' })}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', width: '100%',
                padding: '6px 8px', borderRadius: 'var(--r-sm)', cursor: 'pointer', font: 'inherit',
                background: usingOllama ? 'var(--brand-wash-strong)' : 'transparent',
                border: `1px solid ${usingOllama ? 'var(--brand)' : 'var(--line)'}`,
              }}>
              <Icon name="Bash" size={13} color={usingOllama ? 'var(--brand)' : 'var(--ink-2)'} />
              <span style={{ fontSize: 'var(--fs-sm)', flex: 1 }}>Use local Ollama</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>
                {ollama.host} · {ollama.models.length} model{ollama.models.length === 1 ? '' : 's'}
              </span>
            </button>
          )}
          <Field label="Base URL">
            <TextInput mono placeholder="http://127.0.0.1:11434" value={value.baseUrl ?? ''}
              onChange={(v) => patch({ baseUrl: v })} />
          </Field>
          {usingOllama && ollama.models.length > 0 ? (
            <Field label="Model (blank lets the run pick)">
              <select value={value.model ?? ''} onChange={(e) => patch({ model: e.target.value || undefined })}
                style={{
                  font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', padding: '6px 8px',
                  borderRadius: 'var(--r-sm)', border: '1px solid var(--line-strong)', background: 'var(--bg-card)', color: 'var(--ink-0)',
                }}>
                <option value="">— server picks —</option>
                {ollama.models.map((m) => (
                  <option key={m.id} value={m.id}>{m.id}{m.remote ? ' (cloud)' : ''}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Model (blank lets the run pick)">
              <TextInput mono placeholder="llama3.1" value={value.model ?? ''}
                onChange={(v) => patch({ model: v || undefined })} />
            </Field>
          )}
          <Field label="Label (shown in place of the raw URL)">
            <TextInput placeholder="OpenRouter" value={value.label ?? ''}
              onChange={(v) => patch({ label: v || undefined })} />
          </Field>
          <Field label="Environment variable (blank when the endpoint needs no key)">
            <TextInput mono placeholder="OPENROUTER_API_KEY" value={value.apiKeyEnv ?? ''}
              onChange={(v) => patch({ apiKeyEnv: v || undefined })} />
          </Field>
          {!!value.apiKeyEnv && <EnvVarHint />}
        </div>
      )}
    </div>
  );
}
