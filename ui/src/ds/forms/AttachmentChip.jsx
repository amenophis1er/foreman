import React, { useState } from 'react';
import { Icon } from '../core/Icon';

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic)$/i;
const CODE = /\.(js|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|css|html|json|ya?ml|toml|sh|sql|md)$/i;

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** A file attached to a brief: type icon, name (mono), size, remove. */
export function AttachmentChip({ name, size, onRemove, style }) {
  const [hover, setHover] = useState(false);
  const icon = IMAGE.test(name) ? 'image' : CODE.test(name) ? 'code' : 'file';
  return (
    <span onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 260, height: 24, padding: '0 4px 0 8px',
      background: 'var(--bg-inset)', border: `1px solid ${hover ? 'var(--line-strong)' : 'var(--line)'}`, borderRadius: 'var(--r-sm)',
      fontSize: 'var(--fs-sm)', color: 'var(--ink-0)', ...style,
    }}>
      <Icon name={icon} size={13} color="var(--ink-2)" />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {size != null && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{formatBytes(size)}</span>}
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} style={{
          display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', borderRadius: 3, padding: 0, cursor: 'pointer', color: 'var(--ink-2)',
        }}><Icon name="close" size={12} /></button>
      )}
    </span>
  );
}
