import React, { useState } from 'react';
import { Modal, ModalHeader, ModalFooter } from './Modal';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/** Disambiguates a dropped folder: browsers expose only its name, so the server offers candidate paths. */
export function DropConfirmModal({ name, matches, onPick, onClose }) {
  const [hover, setHover] = useState(null);
  return (
    <Modal width={520} onClose={onClose} style={{ maxHeight: '60vh' }}>
      <ModalHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--fw-semibold)' }}><Icon name="folder" size={16} color="var(--ink-1)" />{name}</div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', marginTop: 2 }}>
          Browsers hide dropped folders' full paths — pick the matching location.
        </div>
      </ModalHeader>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {matches == null && (
          <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>Searching your home folder…</div>
        )}
        {matches?.map((m) => (
          <div key={m} role="button" onClick={() => onPick?.(m)}
            onMouseEnter={() => setHover(m)} onMouseLeave={() => setHover(null)}
            style={{ padding: '8px 12px', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', background: hover === m ? 'var(--bg-card)' : 'transparent', transition: 'background var(--dur-fast) var(--ease)' }}>{m}</div>
        ))}
        {matches?.length === 0 && (
          <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>
            No folder named “{name}” found under your home directory — use the folder picker instead.
          </div>
        )}
      </div>
      <ModalFooter style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onClose}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
}

/** Full-view dashed gold overlay shown while a folder is dragged over the fleet. */
export function DropOverlay({ children = 'Drop a folder to link it' }) {
  return (
    <div style={{
      position: 'absolute', inset: 8, zIndex: 5, pointerEvents: 'none',
      border: '2px dashed var(--brand)', borderRadius: 'var(--r-md)',
      background: 'var(--brand-wash)', display: 'flex', alignItems: 'center', gap: 10,
      justifyContent: 'center', color: 'var(--brand)', fontSize: 'var(--fs-lg)',
    }}><Icon name="folder" size={20} />{children}</div>
  );
}
