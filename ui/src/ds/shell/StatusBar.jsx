import React from 'react';
import { Icon } from '../core/Icon';
import { BillingBadge } from '../status/BillingBadge';

/**
 * The status bar: one thin line at the foot of every screen, the IDE kind.
 *
 * It answers the questions that used to crowd the header or had no home:
 * is the tab connected, where is Foreman reachable, is the phone linked,
 * who pays, which version is this and is there a newer one. Nothing here is
 * an action — a click on a segment opens the Settings section that owns it.
 */
function Seg({ children, title, onClick, tone }) {
  const color = tone === 'warn' ? 'var(--status-warning)' : tone === 'bad' ? 'var(--status-error)' : 'var(--ink-2)';
  const inner = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color, whiteSpace: 'nowrap', minWidth: 0 }}>{children}</span>
  );
  if (!onClick) return <span title={title} style={{ display: 'inline-flex', minWidth: 0 }}>{inner}</span>;
  return (
    <button type="button" onClick={onClick} title={title}
      style={{ background: 'none', border: 0, padding: '0 2px', margin: '0 -2px', font: 'inherit', cursor: 'pointer', display: 'inline-flex', minWidth: 0, borderRadius: 3 }}>
      {inner}
    </button>
  );
}

const Dot = ({ color }) => <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: '0 0 auto' }} />;
const Sep = () => <span aria-hidden style={{ width: 1, height: 12, background: 'var(--line)', margin: '0 var(--sp-2)', flex: '0 0 auto' }} />;

const bare = (url) => String(url ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');

export function StatusBar({ connected, localUrl, publicUrl, phone, auth, version, update, onOpenSettings, style }) {
  const https = typeof publicUrl === 'string' && publicUrl.startsWith('https://');
  const tailnet = publicUrl && bare(publicUrl) !== bare(localUrl) ? publicUrl : null;
  return (
    <footer style={{
      display: 'flex', alignItems: 'center', gap: 0, flex: '0 0 auto', minHeight: 24,
      padding: '2px var(--sp-4)', background: 'var(--bg-panel)', borderTop: '1px solid var(--line)',
      fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', ...style,
    }}>
      <Seg title={connected ? 'Live: this tab follows the server’s event stream' : 'Disconnected: the tab lost the server’s event stream and is reconnecting'}
        tone={connected ? undefined : 'bad'}>
        <Dot color={connected ? 'var(--status-success)' : 'var(--status-error)'} />
        {connected ? 'connected' : 'disconnected'}
      </Seg>
      <Sep />
      <Seg title={`Serving on ${localUrl}${tailnet ? ` and, on your tailnet, ${tailnet}${https ? ' (HTTPS via tailscale serve)' : ' (plain HTTP — foreman doctor shows the one command for HTTPS)'}` : ''}`}>
        <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bare(localUrl)}</span>
        {tailnet && (
          <>
            <span aria-hidden>·</span>
            <Icon name={https ? 'approval' : 'provider'} size={12} color={https ? 'var(--status-success)' : 'var(--ink-2)'} />
            <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{bare(tailnet)}</span>
          </>
        )}
      </Seg>
      {phone !== undefined && (
        <>
          <Sep />
          <Seg onClick={() => onOpenSettings?.('notifications')}
            title={phone ? `Telegram linked to ${phone}. Approvals, questions and the front desk reach that chat. Click for Notifications.` : 'No phone linked. Settings → Notifications links a Telegram chat: approvals, questions and the front desk on the move.'}
>
            <Icon name="needsYou" size={12} />
            {phone ? `phone ${phone}` : 'no phone linked'}
          </Seg>
        </>
      )}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
        {auth && (
          <>
            <Seg onClick={() => onOpenSettings?.('provider')} title="Who pays for missions by default. Click for Provider.">
              <BillingBadge mode={auth.mode} source={auth.source} account={auth.account} compact />
            </Seg>
            <Sep />
          </>
        )}
        {update && (
          <>
            <Seg tone="warn" title={`You run ${update.current}; ${update.latest} is on npm. In a terminal: foreman update — it refuses while a mission is live.`}>
              {update.latest} available · <span style={{ fontFamily: 'var(--font-mono)' }}>foreman update</span>
            </Seg>
            <Sep />
          </>
        )}
        {version && (
          <a href="https://github.com/amenophis1er/foreman/releases" target="_blank" rel="noopener noreferrer"
            title={`Foreman ${version} — release notes`}
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-2)', textDecoration: 'none', whiteSpace: 'nowrap' }}>
            v{version}
          </a>
        )}
      </span>
    </footer>
  );
}
