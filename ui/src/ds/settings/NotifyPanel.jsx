import React, { useState } from 'react';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { TextInput } from '../forms/TextInput';
import { Banner } from '../status/Banner';

/**
 * Where notifications go when the human is not looking at the tab.
 *
 * Telegram first, because it needs no credential minted: the human makes a
 * bot with @BotFather and pastes its token; Foreman stores it write-only —
 * the panel can say a token exists and never show it, exactly like a provider
 * key — and links a chat with a one-time code the human sends to their own
 * bot. Nothing here reaches outside the machine except Telegram's Bot API.
 *
 * The toggles above this panel (needs you / run finished / budget) are the
 * channel's filter too. There is deliberately no second set.
 */
export function NotifyPanel({
  status, busy, error,
  onSaveToken, onClearToken, onLink, onUnlink, onTest, onSavePublicUrl, style,
}) {
  const [token, setToken] = useState('');
  const [editingToken, setEditingToken] = useState(false);
  const [publicUrl, setPublicUrl] = useState(null);
  const tg = status?.telegram;
  const hasToken = Boolean(tg?.hasToken);
  const linked = Boolean(tg?.chatId);
  const linking = tg?.linking;
  const url = publicUrl ?? status?.publicUrl ?? '';
  const urlDirty = publicUrl !== null && publicUrl !== (status?.publicUrl ?? '');

  const row = (label, hint, control) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-3)', padding: 'var(--sp-2) 0', borderTop: '1px solid var(--line)' }}>
      <div style={{ flex: '0 0 180px' }}>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--ink-0)' }}>{label}</div>
        {hint && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh)' }}>{hint}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>{control}</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)' }}>
        <Icon name="send" size={13} color="var(--brand)" /> Telegram
        <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontWeight: 'var(--fw-normal)' }}>
          {linked ? `linked · ${tg.chatLabel || tg.chatId}` : hasToken ? 'token stored · not linked' : 'not set up'}
          {status?.delivered ? ` · ${status.delivered} sent` : ''}
          {status?.failures ? ` · ${status.failures} failed` : ''}
        </span>
      </div>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', lineHeight: 'var(--lh-prose)' }}>
        Approvals, questions, stalls and finished missions arrive in a chat with your own bot, using the toggles above.
        Every ask still has its unattended default — this makes it less likely to be needed.
      </div>

      {error && <Banner tone="error" inline>{error}</Banner>}

      {row('Bot token',
        <>Create a bot with <span style={{ fontFamily: 'var(--font-mono)' }}>@BotFather</span> and paste its token. Stored write-only; Foreman can replace it but never show it.</>,
        hasToken && !editingToken ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-sm)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-1)' }}>{tg?.bot || 'token stored'}</span>
            <Button size="sm" variant="ghost" onClick={() => setEditingToken(true)} disabled={busy}>Replace</Button>
            <Button size="sm" variant="ghost" onClick={onClearToken} disabled={busy}>Remove</Button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
            <TextInput mono type="password" width={320} placeholder="123456789:AA…" value={token} onChange={setToken} />
            <Button size="sm" variant="primary" disabled={busy || !token.trim()}
              onClick={() => { onSaveToken?.(token.trim()); setToken(''); setEditingToken(false); }}>
              {busy ? 'Checking…' : 'Save'}
            </Button>
            {hasToken && <Button size="sm" variant="ghost" onClick={() => setEditingToken(false)}>Cancel</Button>}
          </div>
        ))}

      {row('Linked chat',
        'Send the one-time command to your bot from the chat that should receive messages. Only that chat is ever written to.',
        linked ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', fontSize: 'var(--fs-sm)' }}>
            <Icon name="check" size={13} color="var(--status-ok, var(--brand))" />
            <span>{tg.chatLabel || 'linked'} <span style={{ color: 'var(--ink-2)', fontFamily: 'var(--font-mono)' }}>{tg.chatId}</span></span>
            <Button size="sm" variant="ghost" onClick={onTest} disabled={busy}>Send test</Button>
            <Button size="sm" variant="ghost" onClick={onUnlink} disabled={busy}>Unlink</Button>
          </div>
        ) : linking ? (
          <div style={{ display: 'flex', gap: 'var(--sp-3)', alignItems: 'flex-start' }}>
            {/* One scan, one tap: the QR is the t.me deep link, which opens the
                bot with the /start command pre-filled. The code stays visible
                for a desktop Telegram, or for anyone who would rather type. */}
            {linking.deepLink && (
              <a href={linking.deepLink} target="_blank" rel="noreferrer" title="Open in Telegram"
                style={{ flex: '0 0 auto', display: 'block', padding: 6, background: '#fff', borderRadius: 'var(--r-sm)', border: '1px solid var(--line-strong)', lineHeight: 0 }}>
                <img src={`/notify/telegram/qr.svg?c=${encodeURIComponent(linking.code)}`} alt={`QR: ${linking.deepLink}`}
                  width={132} height={132} style={{ display: 'block' }} />
              </a>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--fs-sm)', minWidth: 0 }}>
              <div>Scan with your phone, or send this to your bot:</div>
              <code style={{
                alignSelf: 'flex-start', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-lg)',
                padding: '4px 10px', background: 'var(--bg-inset)', border: '1px solid var(--line-strong)', borderRadius: 'var(--r-sm)',
              }}>/start {linking.code}</code>
              {linking.deepLink && (
                <a href={linking.deepLink} target="_blank" rel="noreferrer"
                  style={{ fontSize: 'var(--fs-xs)', color: 'var(--brand)', textDecoration: 'none' }}>
                  Open in Telegram on this computer →
                </a>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', flexWrap: 'wrap' }}>
                <span className="pulse" style={{ display: 'inline-flex' }}><Icon name="loading" size={12} /></span>
                waiting… the code expires in 10 minutes
                <Button size="sm" variant="ghost" onClick={onLink} disabled={busy}>New code</Button>
              </div>
            </div>
          </div>
        ) : (
          <div>
            <Button size="sm" variant="primary" onClick={onLink} disabled={busy || !hasToken}
              title={hasToken ? 'Shows a one-time code to send to your bot' : 'Store a bot token first'}>Link a chat</Button>
          </div>
        ))}

      {row('Foreman URL',
        'Where links in messages point. A phone cannot open localhost — use a LAN or Tailscale address if you have one.',
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <TextInput mono width={320} value={url} onChange={setPublicUrl} placeholder="http://localhost:4177" />
          <Button size="sm" disabled={busy || !urlDirty} onClick={() => { onSavePublicUrl?.(url); setPublicUrl(null); }}>Save</Button>
        </div>)}
    </div>
  );
}
