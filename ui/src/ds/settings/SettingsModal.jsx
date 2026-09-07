import React, { useState } from 'react';
import { Modal, ModalFooter } from '../overlay/Modal';
import { Button } from '../core/Button';
import { IconButton } from '../core/IconButton';
import { Icon } from '../core/Icon';
import { Tabs } from '../core/Tabs';
import { Switch } from '../forms/Switch';
import { TextInput } from '../forms/TextInput';
import { ModelSelect } from '../forms/ModelSelect';
import { ProviderPicker } from './ProviderPicker';
import { Empty } from '../core/Empty';
import { NotifyPanel } from './NotifyPanel';

export const SETTINGS_SECTIONS = [
  // Provider leads because it decides what every other section can offer: the
  // model list is scoped to it, and it names who pays. It was buried under
  // Projects, where nobody found it — including its author, twice.
  { id: 'provider', label: 'Provider', icon: 'provider' },
  { id: 'models', label: 'Models', icon: 'model' },
  { id: 'budget', label: 'Budget', icon: 'budget' },
  { id: 'approvals', label: 'Approvals', icon: 'approval' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'notifications', label: 'Notifications', icon: 'needsYou' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
];

export const DEFAULT_SETTINGS = {
  // Opus is the default director: strong enough to plan and verify, without
  // Fable's frontier price on every mission.
  directorModel: 'opus', workerModel: 'sonnet', plannerModel: 'sonnet',
  budgetCap: 5, budgetWarnAt: 80, budgetHardStop: true,
  autoAllowReadOnly: true, alwaysSurvivesResume: true,
  toolPolicy: { Bash: 'allow', Write: 'allow', Edit: 'allow', WebFetch: 'allow', spawn_worker: 'allow' },
  theme: 'light', textSize: 'default', density: 'comfortable', showTimestamps: true,
  notifyNeedsYou: true, notifyDone: true, notifyBudget: true, sound: false,
  gitBranchPerMission: true,
  projectsRoot: '~/Projects', missionDir: '.foreman', showHidden: false,
};

const POLICY = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }];
const GUARDED = ['Bash', 'Write', 'Edit', 'WebFetch', 'spawn_worker'];

/**
 * Global settings with an optional per-project overlay. In project scope every row shows whether it inherits or overrides;
 * overrides can be reset to global. Nothing persists until Save.
 */
/**
 * What this machine can serve, in global scope.
 *
 * A provider is a per-project choice, so there is nothing to set here — but
 * this is the panel someone reaches from the fleet, and an empty one reads as
 * broken. Listing what Foreman can already see turns a dead end into the
 * answer to "what are my options", and says where to go to use them.
 */
function ServerProviders({ instances = [], ollama, codex }) {
  const found = [
    ...instances.map((i) => ({
      icon: 'orchestration',
      name: 'Claude Code',
      detail: i.configDir,
      note: i.hasStoredLogin ? 'signed in' : 'no stored login',
    })),
    ...(ollama ? [{
      icon: 'model', name: 'Ollama', detail: ollama.host,
      note: `${ollama.models.length} model${ollama.models.length === 1 ? '' : 's'}`,
    }] : []),
    ...(codex ? [{
      icon: 'provider', name: 'Codex', detail: codex.home,
      note: codex.signedIn ? 'signed in' : 'not signed in',
    }] : []),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', lineHeight: 'var(--lh-prose)' }}>
        A provider is chosen per project — open one and its tab appears beside
        <b style={{ color: 'var(--ink-0)' }}> Global</b> above. These are what this machine can offer.
      </div>
      {found.length === 0 && (
        <Empty>Nothing detected. An Anthropic API key or any OpenAI-compatible endpoint still works.</Empty>
      )}
      {found.map((f, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 'var(--sp-2)',
          padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-inset)',
          border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
        }}>
          <Icon name={f.icon} size={14} color="var(--ink-2)" />
          <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>{f.name}</span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{f.detail}</span>
          <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{f.note}</span>
        </div>
      ))}
    </div>
  );
}

export function SettingsModal({ global, project, projectName, models, modelsLoading, modelsNote, provider, providerInstances, providerOllama, providerCodex, providerHasKey, providerKeyBusy, providerKeyError, onStoreProviderKey, onClearProviderKey, notify, scope: scopeProp, onScope, section: sectionProp, onSection, onSave, onClose, onUnlink, style }) {
  const [localScope, setLocalScope] = useState(scopeProp ?? 'global');
  const [localSection, setLocalSection] = useState(sectionProp ?? 'models');
  const scope = onScope ? scopeProp : localScope;
  const setScope = onScope ?? setLocalScope;
  const section = onSection ? sectionProp : localSection;
  const setSection = onSection ?? setLocalSection;
  const [g, setG] = useState({ ...DEFAULT_SETTINGS, ...global });
  const [p, setP] = useState({ ...project });
  // The provider pin isn't a settings key — it's saved through PATCH
  // /projects/:id, not PUT /settings — so it gets its own bit of state and
  // its own dirty check, then rides along in onSave for the caller to route.
  const [prov, setProv] = useState(provider ?? null);
  const providerDirty = JSON.stringify(prov) !== JSON.stringify(provider ?? null);
  const dirty = JSON.stringify(g) !== JSON.stringify({ ...DEFAULT_SETTINGS, ...global }) || JSON.stringify(p) !== JSON.stringify({ ...project }) || providerDirty;
  const isProject = scope === 'project';

  const get = (k) => (isProject && k in p ? p[k] : g[k]);
  const set = (k, v) => (isProject ? setP((s) => ({ ...s, [k]: v })) : setG((s) => ({ ...s, [k]: v })));
  const overridden = (k) => isProject && k in p;
  const reset = (k) => setP((s) => { const n = { ...s }; delete n[k]; return n; });
  const row = (k, label, hint, control) => <Row label={label} hint={hint} overridden={overridden(k)} inherits={isProject && !overridden(k)} onReset={() => reset(k)}>{control}</Row>;

  const body = {
    models: <>
      {row('directorModel', 'Director', 'Plans, delegates, verifies. Opus by default; Fable for long-horizon work.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('directorModel')} onChange={(v, m) => { set('directorModel', v); set('directorProviderId', m?.providerId); }} />)}
      {row('workerModel', 'Workers', 'Implement scoped tasks. Cheaper models cut cost sharply.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('workerModel')} onChange={(v, m) => { set('workerModel', v); set('workerProviderId', m?.providerId); }} />)}
      {row('plannerModel', 'Planner', 'Talks the next mission through with you and reads the project. Conversation, not deep reasoning; Sonnet by default.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('plannerModel')} onChange={(v) => set('plannerModel', v)} />)}
      {!isProject && row('fleetPlannerModel', 'Fleet planner', 'The front desk on your phone: knows every project, opens planning, proposes, steers. Fast tool calls matter more than depth; follows the planner when unset.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('fleetPlannerModel') || get('plannerModel')} onChange={(v) => set('fleetPlannerModel', v)} />)}
    </>,
    budget: <>
      {row('budgetCap', 'Default cap per run', 'The composer starts here; you can change it per mission.', <TextInput type="number" prefix="$" min={0} step={1} width={110} value={get('budgetCap')} onChange={(v) => set('budgetCap', v)} />)}
      {row('budgetWarnAt', 'Warn at', 'Meter turns amber and, if enabled, you get a notification.', <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TextInput type="number" min={10} max={100} step={5} width={80} value={get('budgetWarnAt')} onChange={(v) => set('budgetWarnAt', v)} /><span style={{ color: 'var(--ink-2)' }}>%</span></span>)}
      {row('budgetHardStop', 'Hard stop at cap', 'Off: the run pauses and asks instead of stopping.', <Switch checked={get('budgetHardStop')} onChange={(v) => set('budgetHardStop', v)} />)}
    </>,
    approvals: <>
      {row('autoAllowReadOnly', 'Auto-allow read-only tools', 'Read, Grep, Glob, LS never prompt.', <Switch checked={get('autoAllowReadOnly')} onChange={(v) => set('autoAllowReadOnly', v)} />)}
      {row('alwaysSurvivesResume', '“Always (run)” survives resume', 'Grants made during a run carry into a resumed run.', <Switch checked={get('alwaysSurvivesResume')} onChange={(v) => set('alwaysSurvivesResume', v)} />)}
      <Row label="Guarded tools" hint="Policy per tool. “Ask” escalates to an approval card; writes outside the project folder always ask." overridden={overridden('toolPolicy')} inherits={isProject && !overridden('toolPolicy')} onReset={() => reset('toolPolicy')} stacked>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {GUARDED.map((t) => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name={t} size={14} color="var(--ink-2)" />
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', flex: 1 }}>{t}</span>
              <Tabs size="sm" tabs={POLICY} value={get('toolPolicy')[t] || 'ask'} onChange={(v) => set('toolPolicy', { ...get('toolPolicy'), [t]: v })} />
            </div>
          ))}
        </div>
      </Row>
    </>,
    appearance: <>
      {row('theme', 'Theme', null, <Tabs size="sm" value={get('theme')} onChange={(v) => set('theme', v)} tabs={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }]} />)}
      {row('textSize', 'Text size', 'Scales the whole interface. Anything but Default overrides your browser\u2019s own font size.', <Tabs size="sm" value={get('textSize')} onChange={(v) => set('textSize', v)} tabs={[{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }, { value: 'larger', label: 'Larger' }]} />)}
      {row('density', 'Density', 'Compact tightens transcript rows and rail padding.', <Tabs size="sm" value={get('density')} onChange={(v) => set('density', v)} tabs={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />)}
      {row('showTimestamps', 'Timestamps in transcript', null, <Switch checked={get('showTimestamps')} onChange={(v) => set('showTimestamps', v)} />)}
    </>,
    notifications: <>
      {row('notifyNeedsYou', 'Needs you', 'An approval or question is waiting.', <Switch checked={get('notifyNeedsYou')} onChange={(v) => set('notifyNeedsYou', v)} />)}
      {row('notifyDone', 'Run finished', 'Done, errored or interrupted.', <Switch checked={get('notifyDone')} onChange={(v) => set('notifyDone', v)} />)}
      {row('notifyBudget', 'Budget warning', 'When spend crosses the warn threshold.', <Switch checked={get('notifyBudget')} onChange={(v) => set('notifyBudget', v)} />)}
      {row('sound', 'Sound', null, <Switch checked={get('sound')} onChange={(v) => set('sound', v)} />)}
      {/* The channel obeys the toggles above; it is global because a bot
          and a chat belong to the operator, not to a project. */}
      {!isProject && notify && <NotifyPanel {...notify} />}
    </>,
    provider: isProject ? (
      <Row label="Provider"
        hint="Which engine runs this project's agents, who pays, and where requests go. Clearing it returns to the server default."
        stacked>
        <ProviderPicker
          value={prov} onChange={setProv}
          instances={providerInstances} ollama={providerOllama}
          hasKey={providerHasKey} keyBusy={providerKeyBusy} keyError={providerKeyError}
          onStoreKey={onStoreProviderKey} onClearKey={onClearProviderKey} />
      </Row>
    ) : (
      // Global scope cannot set a provider — it is a per-project choice — but
      // it is where someone arrives from the fleet, so it says what this
      // machine can offer rather than showing an empty panel.
      <ServerProviders instances={providerInstances} ollama={providerOllama} codex={providerCodex} />
    ),
    projects: <>
      {!isProject && row('projectsRoot', 'Projects root', 'Where the folder picker opens.', <TextInput mono width={260} value={get('projectsRoot')} onChange={(v) => set('projectsRoot', v)} />)}
      {row('missionDir', 'Mission folder', 'Relative to the project. Holds MISSION.md and run history.', <TextInput mono width={160} value={get('missionDir')} onChange={(v) => set('missionDir', v)} />)}
      {row('gitBranchPerMission', 'Each mission on its own branch', 'In a git repository: Foreman creates foreman/<mission> from what is checked out, commits the work on it at the end, and never merges or pushes. Off: missions edit the current branch.', <Switch checked={get('gitBranchPerMission') !== false} onChange={(v) => set('gitBranchPerMission', v)} />)}
      {!isProject && row('showHidden', 'Show hidden folders in picker', null, <Switch checked={get('showHidden')} onChange={(v) => set('showHidden', v)} />)}
      {isProject && (
        <Row label="Unlink this project" hint="Removes it from the fleet. Files on disk are untouched." danger>
          <Button variant="danger" size="sm" icon="unlink" onClick={onUnlink}>Unlink</Button>
        </Row>
      )}
    </>,
  };

  const current = SETTINGS_SECTIONS.find((s) => s.id === section) || SETTINGS_SECTIONS[0];
  return (
    <Modal width="51.25rem" onClose={onClose} dismissible={false} style={{ maxHeight: '82vh', height: '37.5rem', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-2) var(--sp-3)', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>Settings</span>
        {/* Opened from a project, the project comes first: it is what the
            person came to change, and Global is the way up, not the default. */}
        <Tabs size="sm" value={scope} onChange={setScope} tabs={[...(projectName ? [{ value: 'project', label: projectName, icon: 'folder' }] : []), { value: 'global', label: 'Global' }]} />
        <IconButton icon="close" label="Close" onClick={onClose} style={{ marginLeft: 'auto' }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '11.25rem 1fr' }}>
        <nav style={{ background: 'var(--bg-inset)', borderRight: '1px solid var(--line)', padding: 'var(--sp-2)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SETTINGS_SECTIONS.map((s) => <NavItem key={s.id} s={s} selected={s.id === section} dot={isProject && (sectionHasOverride(s.id, p) || (s.id === 'provider' && !!prov))} onClick={() => setSection(s.id)} />)}
        </nav>
        <div style={{ minHeight: 0, overflowY: 'auto', padding: 'var(--sp-3) var(--sp-5)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
            <span style={{ fontSize: 'var(--fs-lg)', fontWeight: 'var(--fw-semibold)' }}>{current.label}</span>
            {isProject && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>Overrides for <span style={{ fontFamily: 'var(--font-mono)' }}>{projectName}</span>. Rows without a change inherit global.</span>}
          </div>
          {body[current.id]}
        </div>
      </div>
      <ModalFooter>
        <span style={{ fontSize: 'var(--fs-xs)', color: dirty ? 'var(--status-warning)' : 'var(--ink-2)' }}>{dirty ? 'Unsaved changes' : 'Nothing to save'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--sp-2)' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dirty} onClick={() => onSave?.({ global: g, project: p, provider: providerDirty ? prov : undefined })}>Save</Button>
        </span>
      </ModalFooter>
    </Modal>
  );
}

const SECTION_KEYS = {
  models: ['directorModel', 'workerModel', 'plannerModel', 'fleetPlannerModel', 'directorProviderId', 'workerProviderId'], budget: ['budgetCap', 'budgetWarnAt', 'budgetHardStop'],
  approvals: ['autoAllowReadOnly', 'alwaysSurvivesResume', 'toolPolicy'], appearance: ['theme', 'density', 'showTimestamps'],
  notifications: ['notifyNeedsYou', 'notifyDone', 'notifyBudget', 'sound'], projects: ['missionDir', 'gitBranchPerMission'],
};
function sectionHasOverride(id, p) { return (SECTION_KEYS[id] || []).some((k) => k in p); }

function NavItem({ s, selected, dot, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} aria-current={selected || undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 'var(--r-sm)', border: 'none', textAlign: 'left',
        cursor: 'pointer', font: 'inherit', color: selected ? 'var(--ink-0)' : 'var(--ink-1)', fontWeight: selected ? 'var(--fw-semibold)' : 'var(--fw-regular)',
        background: selected ? 'var(--bg-card)' : hover ? 'var(--bg-hover)' : 'transparent',
        boxShadow: selected ? 'inset 0 0 0 1px var(--line-strong)' : 'none',
      }}>
      <Icon name={s.icon} size={14} color={selected ? 'var(--brand)' : 'var(--ink-2)'} />
      <span style={{ flex: 1 }}>{s.label}</span>
      {dot && <span title="Has project overrides" style={{ width: 6, height: 6, borderRadius: 'var(--r-pill)', background: 'var(--brand)' }} />}
    </button>
  );
}

/** Label + hint on the left, control on the right. In project scope an `inherits` tag or an `override · reset` pair shows provenance. */
function Row({ label, hint, children, overridden, inherits, onReset, stacked, danger }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: stacked ? '1fr' : '1fr auto', gap: stacked ? 10 : 'var(--sp-4)', alignItems: 'center',
      padding: 'var(--sp-3) 0', borderBottom: '1px solid var(--line)',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: danger ? 'var(--status-critical)' : 'var(--ink-0)' }}>
          <span>{label}</span>
          {inherits && <Tag>global</Tag>}
          {overridden && <><Tag brand>override</Tag><button type="button" onClick={onReset} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>reset to global</button></>}
        </div>
        {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ display: 'flex', justifyContent: stacked ? 'stretch' : 'flex-end', minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Tag({ children, brand }) {
  return <span style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.06em', textTransform: 'uppercase', padding: '1px 6px', borderRadius: 'var(--r-pill)', background: brand ? 'var(--brand-wash-strong)' : 'var(--bg-inset)', color: brand ? 'var(--brand)' : 'var(--ink-2)', border: `1px solid ${brand ? 'transparent' : 'var(--line)'}` }}>{children}</span>;
}
