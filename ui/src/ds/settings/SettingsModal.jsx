import React, { useState } from 'react';
import { Modal, ModalFooter } from '../overlay/Modal';
import { Button } from '../core/Button';
import { IconButton } from '../core/IconButton';
import { Icon } from '../core/Icon';
import { Tabs } from '../core/Tabs';
import { Switch } from '../forms/Switch';
import { TextInput } from '../forms/TextInput';
import { ModelSelect } from '../forms/ModelSelect';

export const SETTINGS_SECTIONS = [
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
  directorModel: 'opus', workerModel: 'sonnet',
  budgetCap: 5, budgetWarnAt: 80, budgetHardStop: true,
  autoAllowReadOnly: true, alwaysSurvivesResume: true,
  toolPolicy: { Bash: 'allow', Write: 'allow', Edit: 'allow', WebFetch: 'allow', spawn_worker: 'allow' },
  theme: 'system', textSize: 'default', density: 'comfortable', showTimestamps: true,
  notifyNeedsYou: true, notifyDone: true, notifyBudget: true, sound: false,
  projectsRoot: '~/Projects', missionDir: '.foreman', showHidden: false,
};

const POLICY = [{ value: 'allow', label: 'Allow' }, { value: 'ask', label: 'Ask' }, { value: 'deny', label: 'Deny' }];
const GUARDED = ['Bash', 'Write', 'Edit', 'WebFetch', 'spawn_worker'];

/**
 * Global settings with an optional per-project overlay. In project scope every row shows whether it inherits or overrides;
 * overrides can be reset to global. Nothing persists until Save.
 */
export function SettingsModal({ global, project, projectName, scope: scopeProp, onScope, section: sectionProp, onSection, onSave, onClose, onUnlink, style }) {
  const [localScope, setLocalScope] = useState(scopeProp ?? 'global');
  const [localSection, setLocalSection] = useState(sectionProp ?? 'models');
  const scope = onScope ? scopeProp : localScope;
  const setScope = onScope ?? setLocalScope;
  const section = onSection ? sectionProp : localSection;
  const setSection = onSection ?? setLocalSection;
  const [g, setG] = useState({ ...DEFAULT_SETTINGS, ...global });
  const [p, setP] = useState({ ...project });
  const dirty = JSON.stringify(g) !== JSON.stringify({ ...DEFAULT_SETTINGS, ...global }) || JSON.stringify(p) !== JSON.stringify({ ...project });
  const isProject = scope === 'project';

  const get = (k) => (isProject && k in p ? p[k] : g[k]);
  const set = (k, v) => (isProject ? setP((s) => ({ ...s, [k]: v })) : setG((s) => ({ ...s, [k]: v })));
  const overridden = (k) => isProject && k in p;
  const reset = (k) => setP((s) => { const n = { ...s }; delete n[k]; return n; });
  const row = (k, label, hint, control) => <Row label={label} hint={hint} overridden={overridden(k)} inherits={isProject && !overridden(k)} onReset={() => reset(k)}>{control}</Row>;

  const body = {
    models: <>
      {row('directorModel', 'Director', 'Plans, delegates, verifies. Opus by default; Fable for long-horizon work.', <ModelSelect align="right" allowDefault={false} value={get('directorModel')} onChange={(v) => set('directorModel', v)} />)}
      {row('workerModel', 'Workers', 'Implement scoped tasks. Cheaper models cut cost sharply.', <ModelSelect align="right" allowDefault={false} value={get('workerModel')} onChange={(v) => set('workerModel', v)} />)}
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
    </>,
    projects: <>
      {!isProject && row('projectsRoot', 'Projects root', 'Where the folder picker opens.', <TextInput mono width={260} value={get('projectsRoot')} onChange={(v) => set('projectsRoot', v)} />)}
      {row('missionDir', 'Mission folder', 'Relative to the project. Holds MISSION.md and run history.', <TextInput mono width={160} value={get('missionDir')} onChange={(v) => set('missionDir', v)} />)}
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
        <Tabs size="sm" value={scope} onChange={setScope} tabs={[{ value: 'global', label: 'Global' }, ...(projectName ? [{ value: 'project', label: projectName, icon: 'folder' }] : [])]} />
        <IconButton icon="close" label="Close" onClick={onClose} style={{ marginLeft: 'auto' }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '11.25rem 1fr' }}>
        <nav style={{ background: 'var(--bg-inset)', borderRight: '1px solid var(--line)', padding: 'var(--sp-2)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {SETTINGS_SECTIONS.map((s) => <NavItem key={s.id} s={s} selected={s.id === section} dot={isProject && sectionHasOverride(s.id, p)} onClick={() => setSection(s.id)} />)}
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
          <Button variant="primary" disabled={!dirty} onClick={() => onSave?.({ global: g, project: p })}>Save</Button>
        </span>
      </ModalFooter>
    </Modal>
  );
}

const SECTION_KEYS = {
  models: ['directorModel', 'workerModel'], budget: ['budgetCap', 'budgetWarnAt', 'budgetHardStop'],
  approvals: ['autoAllowReadOnly', 'alwaysSurvivesResume', 'toolPolicy'], appearance: ['theme', 'density', 'showTimestamps'],
  notifications: ['notifyNeedsYou', 'notifyDone', 'notifyBudget', 'sound'], projects: ['missionDir'],
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
