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
import { Logo } from '../brand/Logo';

/** The app's one header bar. Fleet mode wears the logo; project mode wears a back button and the job site. */
export function AppHeader({ mode = 'fleet', title, subtitle = 'mission control', folder, onBack, theme, onToggleTheme, onSettings, children, style }) {
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
          <IconButton icon="back" label="Back to fleet" onClick={onBack} />
          <button type="button" onClick={onBack} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', color: 'var(--ink-2)', cursor: 'pointer' }}>Fleet</button>
          <Icon name="chevronRight" size={14} color="var(--ink-3, var(--ink-2))" />
          <span style={{ fontWeight: 'var(--fw-semibold)', whiteSpace: 'nowrap' }}>{title}</span>
          {folder && <FolderPill folder={folder} />}
        </nav>
      )}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
        {children}
        {onToggleTheme && (
          <IconButton icon={theme === 'light' ? 'moon' : 'sun'} label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'} onClick={onToggleTheme} />
        )}
        {onSettings && <IconButton icon="settings" label="Settings" onClick={onSettings} />}
      </div>
    </header>
  );
}
