import React from 'react';
import { IconButton } from '../core/IconButton';
import { Icon } from '../core/Icon';
import { shortPath } from '../core/path';

function FolderPill({ folder }) {
  const [copied, setCopied] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const copy = () => {
    if (navigator.clipboard) navigator.clipboard.writeText(folder).catch(() => {});
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  return (
    <button type="button" onClick={copy} title={copied ? 'Copied' : folder}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 420,
        padding: '3px 8px', borderRadius: 999, border: '1px solid transparent',
        background: hover ? 'var(--bg-inset, rgba(255,255,255,.06))' : 'transparent',
        color: copied ? 'var(--ink-1)' : 'var(--ink-2)', cursor: 'pointer', font: 'inherit',
      }}>
      <Icon name="folder" size={13} />
      <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{copied ? 'copied' : shortPath(folder)}</span>
    </button>
  );
}
import { Logo, LogoMark } from '../brand/Logo';

/** The app's one header bar. Fleet mode wears the full logo; project mode wears the mark (a way home) and the job site. */
export function AppHeader({ mode = 'fleet', title, subtitle = 'mission control', folder, branch, onBack, theme, onToggleTheme, onSettings, version, search, children, style }) {
  const fleet = mode === 'fleet';
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
      padding: fleet ? 'var(--sp-3) var(--sp-5)' : 'var(--sp-2) var(--sp-3)',
      background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)',
      flex: '0 0 auto', minHeight: 48, ...style,
    }}>
      {fleet ? (
        <Logo size={22} tagline={subtitle} />
      ) : (
        <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minWidth: 0 }}>
          {/* The mark stays on every screen — it is the app's name, and the
              way home. The back arrow that used to sit here said the same
              thing twice next to the "Fleet" crumb. */}
          <button type="button" onClick={onBack} title="Back to the fleet" aria-label="Back to the fleet"
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}>
            <LogoMark size={22} />
          </button>
          <button type="button" onClick={onBack} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--ink-2)', cursor: 'pointer' }}>Fleet</button>
          <Icon name="chevronRight" size={14} color="var(--ink-3, var(--ink-2))" />
          <span style={{ fontWeight: 'var(--fw-semibold)', whiteSpace: 'nowrap' }}>{title}</span>
          {folder && <FolderPill folder={folder} />}
          {/* Which branch the folder is on: a run's own, or the project's
              current one, with a dot when the tree is dirty. */}
          {branch && (
            <span title={branch.hint ?? `On branch ${branch.name}${branch.dirty ? ' · uncommitted changes' : ''}`} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 999,
              border: '1px solid var(--line)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--ink-1)', whiteSpace: 'nowrap', maxWidth: 260,
            }}>
              <span aria-hidden style={{ color: 'var(--ink-2)' }}>⎇</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{branch.name}</span>
              {branch.dirty && <span aria-label="uncommitted changes" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--status-warning)', flex: '0 0 auto' }} />}
            </span>
          )}
        </nav>
      )}
      {/* The finder, centred between the name and the controls: the same
          box on every screen, so "where is…" has one answer everywhere. */}
      {search && <div style={{ flex: '1 1 auto', display: 'flex', justifyContent: 'center', minWidth: 0, padding: '0 var(--sp-3)' }}>{search}</div>}
      <div style={{ marginLeft: search ? 0 : 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {children}
        {onToggleTheme && (
          <IconButton icon={theme === 'light' ? 'moon' : 'sun'} label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} onClick={onToggleTheme} />
        )}
        {onSettings && <IconButton icon="settings" label="Settings" onClick={onSettings} />}
        {/* Which Foreman this is. Quiet, mono, last: the answer to "what am
            I running" when something looks off, and never louder than that. */}
        {version && (
          <a href="https://github.com/amenophis1er/foreman/releases" target="_blank" rel="noopener noreferrer"
            title={`Foreman ${version} — release notes`}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
            v{version}
          </a>
        )}
      </div>
    </header>
  );
}
