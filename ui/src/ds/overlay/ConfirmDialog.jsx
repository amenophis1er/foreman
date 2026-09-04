import React from 'react';
import { Modal, ModalHeader, ModalFooter } from './Modal';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';

/** A consequence-stating confirmation. Used for unlink; anything destructive goes through here. */
export function ConfirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'danger', icon, onConfirm, onCancel }) {
  return (
    <Modal width={420} onClose={onCancel}>
      <ModalHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--fw-semibold)' }}>
          {icon && <Icon name={icon} size={16} color={tone === 'danger' ? 'var(--status-critical)' : 'var(--ink-1)'} />}
          {title}
        </div>
      </ModalHeader>
      <div style={{ padding: 'var(--sp-3)', fontSize: 'var(--fs-md)', color: 'var(--ink-1)', lineHeight: 'var(--lh-prose)' }}>{body}</div>
      <ModalFooter style={{ justifyContent: 'flex-end' }}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant={tone} onClick={onConfirm}>{confirmLabel}</Button>
      </ModalFooter>
    </Modal>
  );
}
