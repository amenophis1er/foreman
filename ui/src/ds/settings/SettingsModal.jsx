import React, { useState } from 'react';
import { Modal, ModalFooter } from '../overlay/Modal';
import { Button } from '../core/Button';
import { IconButton } from '../core/IconButton';
import { Icon } from '../core/Icon';
import { Tabs } from '../core/Tabs';
import { Switch } from '../forms/Switch';
import { TextInput } from '../forms/TextInput';
import { Textarea } from '../forms/Textarea';
import { Field } from '../forms/Field';
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
  // Crew sits under Models because it is the same question one level up: not
  // which model a role runs on, but which roles a mission gets at all.
  { id: 'crew', label: 'Crew', icon: 'crew' },
  { id: 'budget', label: 'Budget', icon: 'budget' },
  { id: 'approvals', label: 'Approvals', icon: 'approval' },
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'notifications', label: 'Notifications', icon: 'needsYou' },
  { id: 'projects', label: 'Projects', icon: 'folder' },
];

/**
 * The crew a mission can be given before anyone has edited anything. Kept here
 * as a literal rather than imported from `src/crew.ts`: the ui is a separate
 * package and never imports the server's build. The ids, names, models and
 * `requiredForDone` flags must stay identical to `BUILT_IN_PRESETS` there —
 * they are what a stored preset is matched against.
 */
export const BUILT_IN_PRESETS = [
  {
    id: 'reviewer', name: 'Reviewer', kind: 'reviewer', model: 'opus', toolPolicy: 'read-only', requiredForDone: true,
    brief: 'Review the mission’s diff against MISSION.md and the brief as a demanding senior engineer would. Look for correctness, missing tests, security, and anything the criteria did not name. Verdict PASS only when you would merge it yourself.',
  },
  {
    id: 'security-review', name: 'Security review', kind: 'reviewer', model: 'opus', toolPolicy: 'read-only', requiredForDone: false,
    brief: 'Review the mission’s diff for secrets committed or logged, injection of every kind, path handling that can escape its root, and permissions granted wider than the work needs. Verdict PASS only when none of those is present.',
  },
];

export const DEFAULT_SETTINGS = {
  // Opus is the default director: strong enough to plan and verify, without
  // Fable's frontier price on every mission.
  directorModel: 'opus', workerModel: 'sonnet', plannerModel: 'sonnet',
  budgetCap: 5, budgetWarnAt: 60, budgetHardStop: true,
  // A schedule spends without anyone in the room, so it gets its own ceiling
  // rather than sharing the per-run cap: five runs a night at $5 is a month
  // nobody agreed to.
  scheduledMonthlyCapUsd: 25,
  // Standing crew. Absent from storage means the two built-ins; the first edit
  // writes the whole list back, so what was shown is what gets saved.
  crewPresets: BUILT_IN_PRESETS,
  autoAllowReadOnly: true, alwaysSurvivesResume: true,
  toolPolicy: { Bash: 'allow', Write: 'allow', Edit: 'allow', WebFetch: 'allow', spawn_worker: 'allow' },
  theme: 'light', textSize: 'default', density: 'comfortable', showTimestamps: true,
  notifyNeedsYou: true, notifyDone: true, notifyBudget: true, sound: false,
  gitBranchPerMission: true,
  // A shared checkout is one folder, so one mission at a time; worktrees are
  // what make a second one safe, and two is as many as most machines and most
  // humans can actually follow.
  //
  // These two are sent back verbatim on every Save, so each must be exactly
  // what the server would have used had the key been absent: 'shared' is
  // isolationChoice's fallback, and 2 is DEFAULT_WORKTREE_CONCURRENCY in
  // src/isolation.ts. A 1 here would mean that merely switching a project to
  // worktrees — changing nothing else — persisted a limit of one mission, the
  // opposite of what the switch is for. A shared project is pinned to 1 by the
  // server whatever this says, so nothing is lost by defaulting it to 2.
  isolation: 'shared', maxConcurrentMissions: 2,
  projectsRoot: '~/Projects', missionDir: '.foreman', showHidden: false,
};

const ISOLATION = [{ value: 'shared', label: 'Shared checkout' }, { value: 'worktree', label: 'A worktree per mission' }];
const MAX_CONCURRENT = 5;

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

export function SettingsModal({ global, project, projectName, projectIsRepo, projectGitRoot, projectFolder, saveError, models, modelsLoading, modelsNote, provider, providerInstances, providerOllama, providerCodex, providerHasKey, providerKeyBusy, providerKeyError, onStoreProviderKey, onClearProviderKey, notify, scope: scopeProp, onScope, section: sectionProp, onSection, onSave, onClose, onUnlink, style }) {
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
  // Unknown means the caller has not said (the fleet's global scope, where
  // there is no folder to judge): allow the choice, and let the server refuse.
  const isRepo = projectIsRepo !== false;
  // A folder can be inside a repository without being its top level, and
  // `git worktree add` would check out the whole repository rather than that
  // folder — so the server refuses it exactly as it refuses a plain folder.
  // Same comparison it makes (isolationAllowed in src/isolation.ts, called with
  // the resolved work-tree root against the project's folder); without both
  // paths we do not know, and the choice stays open.
  const isRepoRoot = !(isRepo && projectGitRoot && projectFolder
    && trimSlash(projectGitRoot) !== trimSlash(projectFolder));
  const canWorktree = isRepo && isRepoRoot;
  const worktreeLock = !isRepo
    ? 'only a git repository can run missions in worktrees'
    : 'only the root of a git repository can run missions in worktrees';
  const isolation = get('isolation') === 'worktree' ? 'worktree' : 'shared';
  const worktreeIsolation = canWorktree && isolation === 'worktree';
  const row = (k, label, hint, control) => <Row label={label} hint={hint} overridden={overridden(k)} inherits={isProject && !overridden(k)} onReset={() => reset(k)}>{control}</Row>;

  const body = {
    models: <>
      {row('directorModel', 'Director', 'Plans, delegates, verifies. Opus by default; Fable for long-horizon work.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('directorModel')} onChange={(v, m) => { set('directorModel', v); set('directorProviderId', m?.providerId); }} />)}
      {row('workerModel', 'Workers', 'Implement scoped tasks. Cheaper models cut cost sharply.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('workerModel')} onChange={(v, m) => { set('workerModel', v); set('workerProviderId', m?.providerId); }} />)}
      {row('plannerModel', 'Planner', 'Talks the next mission through with you and reads the project. Conversation, not deep reasoning; Sonnet by default.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('plannerModel')} onChange={(v) => set('plannerModel', v)} />)}
      {!isProject && row('fleetPlannerModel', 'Fleet planner', 'The front desk on your phone: knows every project, opens planning, proposes, steers. Fast tool calls matter more than depth; follows the planner when unset.', <ModelSelect align="right" allowDefault={false} models={models} loading={modelsLoading} note={modelsNote} value={get('fleetPlannerModel') || get('plannerModel')} onChange={(v) => set('fleetPlannerModel', v)} />)}
    </>,
    crew: <>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-1)', lineHeight: 'var(--lh-prose)', paddingBottom: 'var(--sp-2)' }}>
        A preset is a role you can add to a mission when you compose it: a fixed brief, its own model, and how much of the
        machine it is allowed to touch. A reviewer marked
        <b style={{ color: 'var(--ink-0)' }}> required</b> must return <b style={{ color: 'var(--ink-0)' }}>PASS</b> on the
        run’s final diff before Foreman will record the run done.
      </div>
      <Row label="Presets" hint="Offered in the composer, in this order. Nothing here runs on its own."
        overridden={overridden('crewPresets')} inherits={isProject && !overridden('crewPresets')} onReset={() => reset('crewPresets')} stacked>
        <CrewPresets value={get('crewPresets') || BUILT_IN_PRESETS} onChange={(v) => set('crewPresets', v)}
          models={models} modelsLoading={modelsLoading} modelsNote={modelsNote} />
      </Row>
    </>,
    budget: <>
      {row('budgetCap', 'Default cap per run', 'The composer starts here; you can change it per mission.', <TextInput type="number" prefix="$" min={0} step={1} width={110} value={get('budgetCap')} onChange={(v) => set('budgetCap', v)} />)}
      {row('budgetWarnAt', 'Warn at', 'Meter turns amber, the director is told to start verifying, and, if enabled, you get a notification. Leave room: the wind-down turn has to pay for verification and the report.', <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TextInput type="number" min={10} max={100} step={5} width={80} value={get('budgetWarnAt')} onChange={(v) => set('budgetWarnAt', v)} /><span style={{ color: 'var(--ink-2)' }}>%</span></span>)}
      {row('budgetHardStop', 'Hard stop at cap', 'Off: the run pauses and asks instead of stopping.', <Switch checked={get('budgetHardStop')} onChange={(v) => set('budgetHardStop', v)} />)}
      {row('scheduledMonthlyCapUsd', 'Scheduled spend per month', 'All this project’s scheduled runs together, per calendar month. Foreman pauses a schedule before the run that would go past this, rather than stopping it halfway; only you can resume it, from the project view.', <TextInput type="number" prefix="$" min={0} step={5} width={110} value={get('scheduledMonthlyCapUsd')} onChange={(v) => set('scheduledMonthlyCapUsd', v)} />)}
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
      {row('allowWorktreeParent', 'Worktree parent', 'A mission in a git worktree may use the repository it was made from without asking. Sibling worktrees stay closed.',
        <Switch checked={get('allowWorktreeParent') !== false} onChange={(v) => set('allowWorktreeParent', v)} />)}
      {/* Isolation and how many at once are one decision read top to bottom:
          a shared checkout is one folder, so it is always one mission. Only a
          repository can be given worktrees, and the control says so rather
          than letting someone pick a mode the server will refuse. */}
      {row('isolation', 'Isolation',
        canWorktree
          ? 'A worktree project runs each mission in a checkout of its own under Foreman’s home, so the project folder is never moved and more than one mission can run at once. A fresh worktree has no dependencies installed — the crew installs what it needs.'
          : !isRepo
            ? 'Only a git repository can run missions in worktrees. This folder is not one, so its missions share the checkout, one at a time.'
            : 'Only the root of a git repository can run missions in worktrees. This folder is inside one, and a worktree would give the mission the whole repository instead of this folder — so its missions share the checkout, one at a time.',
        <Locked locked={!canWorktree} reason={worktreeLock}>
          <Tabs size="sm" tabs={ISOLATION} value={canWorktree ? isolation : 'shared'} onChange={(v) => set('isolation', v)} />
        </Locked>)}
      {row('maxConcurrentMissions', 'Missions at once',
        worktreeIsolation
          ? `How many missions may run here at the same time, each in a worktree of its own. At most ${MAX_CONCURRENT}.`
          : 'A shared checkout runs one mission at a time — two directors editing one folder is not something Foreman will arrange. Give each mission a worktree above to raise it.',
        <Locked locked={!worktreeIsolation} reason="a shared checkout runs one mission at a time">
          <TextInput type="number" min={1} max={MAX_CONCURRENT} step={1} width={80}
            value={worktreeIsolation ? (get('maxConcurrentMissions') ?? DEFAULT_SETTINGS.maxConcurrentMissions) : 1}
            onChange={(v) => set('maxConcurrentMissions', Math.min(MAX_CONCURRENT, Math.max(1, Number(v) || 1)))} />
        </Locked>)}
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
        {/* The server's own sentence when it refused the save, in the place
            that otherwise says whether there is anything to save — the edits
            are still on screen and still unsaved, which is the truth. */}
        <span style={{
          fontSize: 'var(--fs-xs)', minWidth: 0,
          color: saveError ? 'var(--status-critical)' : dirty ? 'var(--status-warning)' : 'var(--ink-2)',
        }}>{saveError ? `Not saved — ${saveError}` : dirty ? 'Unsaved changes' : 'Nothing to save'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--sp-2)' }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dirty} onClick={() => onSave?.({ global: g, project: p, provider: providerDirty ? prov : undefined })}>Save</Button>
        </span>
      </ModalFooter>
    </Modal>
  );
}

const SECTION_KEYS = {
  models: ['directorModel', 'workerModel', 'plannerModel', 'fleetPlannerModel', 'directorProviderId', 'workerProviderId'], budget: ['budgetCap', 'budgetWarnAt', 'budgetHardStop', 'scheduledMonthlyCapUsd'],
  crew: ['crewPresets'],
  approvals: ['autoAllowReadOnly', 'alwaysSurvivesResume', 'toolPolicy'], appearance: ['theme', 'density', 'showTimestamps'],
  notifications: ['notifyNeedsYou', 'notifyDone', 'notifyBudget', 'sound'],
  projects: ['missionDir', 'gitBranchPerMission', 'isolation', 'maxConcurrentMissions'],
};
function sectionHasOverride(id, p) { return (SECTION_KEYS[id] || []).some((k) => k in p); }

const KINDS = [{ value: 'reviewer', label: 'Reviewer' }, { value: 'specialist', label: 'Specialist' }];
const PRESET_TOOLS = [{ value: 'read-only', label: 'Read-only' }, { value: 'default', label: 'Default' }];

/**
 * The id is machine-facing — it is what a mission stores when it opts into a
 * preset — so it is generated from the name once and never edited afterwards,
 * and never collides with one already in the list.
 */
function presetId(name, taken) {
  const base = String(name || 'preset').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'preset';
  let id;
  do { id = `${base}-${Math.random().toString(36).slice(2, 6)}`; } while (taken.includes(id));
  return id;
}

/**
 * The crew list, edited in place. One row per preset, expanded by clicking it;
 * `onChange` gets the whole array back on every keystroke, because that is what
 * the settings key is — an override replaces the list, it never merges into it.
 */
function CrewPresets({ value, onChange, models, modelsLoading, modelsNote }) {
  const [open, setOpen] = useState(null);
  const patch = (i, k, v) => onChange(value.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const modelLabel = (id) => (models || []).find((m) => m.id === id)?.label || id || 'Default';
  const add = () => {
    const id = presetId('preset', value.map((c) => c.id));
    onChange([...value, { id, name: 'New preset', kind: 'reviewer', model: 'opus', toolPolicy: 'read-only', requiredForDone: false, brief: '' }]);
    setOpen(id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {value.length === 0 && <Empty>No crew. Missions run with the director and its workers only.</Empty>}
      {value.map((c, i) => {
        const expanded = open === c.id;
        return (
          <div key={c.id} style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', background: 'var(--bg-inset)' }}>
            {/* Expanded, this preset is taller than the modal body, so scrolling
                down to its Brief would carry the only line naming the preset off
                the top — you would be editing a brief with nothing on screen
                saying whose it is. Stuck to the top of the section's scroll area,
                the name, kind, model and REQUIRED stay with the fields. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
              ...(expanded ? {
                position: 'sticky', top: 0, zIndex: 1, background: 'var(--bg-inset)',
                borderRadius: 'var(--r-sm) var(--r-sm) 0 0',
              } : null),
            }}>
              <button type="button" onClick={() => setOpen(expanded ? null : c.id)} aria-expanded={expanded}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: 0,
                  background: 'none', border: 0, font: 'inherit', color: 'var(--ink-0)', cursor: 'pointer', textAlign: 'left',
                }}>
                <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} color="var(--ink-2)" />
                <span style={{ fontWeight: 'var(--fw-medium)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <Tag>{c.kind}</Tag>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>{modelLabel(c.model)}</span>
                {c.kind === 'reviewer' && c.requiredForDone && <Tag brand>required</Tag>}
              </button>
              <IconButton icon="close" size="sm" label={`Remove ${c.name}`} onClick={() => onChange(value.filter((_, j) => j !== i))} />
            </div>
            {expanded && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', padding: 'var(--sp-3)', borderTop: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="Name" layout="stacked" style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <TextInput value={c.name} onChange={(v) => patch(i, 'name', v)} />
                  </Field>
                  <Field label="Kind" layout="stacked" hint={c.kind === 'reviewer' ? 'Judges the finished diff.' : 'Works alongside the others.'}>
                    {/* Only a reviewer gates a run, and only a reviewer shows
                        the switch that says so — so becoming a specialist has
                        to drop the flag as well, or the run would still be
                        held by a gate with nothing on screen to explain it. */}
                    <Tabs size="sm" tabs={KINDS} value={c.kind}
                      onChange={(v) => onChange(value.map((x, j) => (j === i
                        ? { ...x, kind: v, requiredForDone: v === 'reviewer' ? x.requiredForDone : false }
                        : x)))} />
                  </Field>
                  <Field label="Model" layout="stacked">
                    <ModelSelect allowDefault={false} models={models} loading={modelsLoading} note={modelsNote}
                      value={c.model || ''} onChange={(v, m) => onChange(value.map((x, j) => (j === i ? { ...x, model: v, providerId: m?.providerId } : x)))} />
                  </Field>
                </div>
                {/* No grabber: it is the one native-styled control in a modal
                    that is otherwise entirely ours, and the box is already the
                    height a brief wants. */}
                <Field label="Brief" layout="stacked" hint="What it is for, and what it must say. A reviewer’s verdict is the word PASS or FAIL on its own line.">
                  <Textarea size="answer" value={c.brief || ''} onChange={(v) => patch(i, 'brief', v)}
                    placeholder="Review the diff for…" style={{ height: 120, resize: 'none' }} />
                </Field>
                <div style={{ display: 'flex', gap: 'var(--sp-4)', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <Field label="Tools" layout="stacked" hint="Read-only: Read, Grep, Glob, LS and nothing else.">
                    <Tabs size="sm" tabs={PRESET_TOOLS} value={c.toolPolicy || 'read-only'} onChange={(v) => patch(i, 'toolPolicy', v)} />
                  </Field>
                  {/* Only a reviewer has a verdict to gate on, so a specialist
                      is not shown a toggle it could never honour. */}
                  {c.kind === 'reviewer' && (
                    <Field label="Required for done" layout="stacked" hint="The run cannot be recorded done until this one passes.">
                      <Switch checked={c.requiredForDone === true} onChange={(v) => patch(i, 'requiredForDone', v)} />
                    </Field>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div><Button size="sm" icon="add" onClick={add}>Add preset</Button></div>
    </div>
  );
}

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

/**
 * A control that cannot be used here, shown rather than hidden: the choice
 * exists, and what is missing is the folder or the mode that would earn it.
 * The reason is on the control itself as well as in the row's hint, because a
 * greyed thing with the explanation two lines away is a thing people click.
 */
function Locked({ locked, reason, children }) {
  if (!locked) return children;
  return (
    <span aria-disabled title={reason} style={{ pointerEvents: 'none', opacity: 0.5, display: 'inline-flex' }}>
      {children}
    </span>
  );
}

/** Two paths compare equal when only a trailing separator differs. */
function trimSlash(p) { return String(p).replace(/[\\/]+$/, ''); }

function Tag({ children, brand }) {
  return <span style={{ fontSize: 'var(--fs-xs)', letterSpacing: '0.06em', textTransform: 'uppercase', padding: '1px 6px', borderRadius: 'var(--r-pill)', background: brand ? 'var(--brand-wash-strong)' : 'var(--bg-inset)', color: brand ? 'var(--brand)' : 'var(--ink-2)', border: `1px solid ${brand ? 'transparent' : 'var(--line)'}` }}>{children}</span>;
}
