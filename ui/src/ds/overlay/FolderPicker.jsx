import React, { useState } from 'react';
import { Modal, ModalHeader, ModalFooter } from './Modal';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { TextInput } from '../forms/TextInput';
import { Banner } from '../status/Banner';

function Row({ children, icon, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div role="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 'var(--fs-md)', background: hover ? 'var(--bg-card)' : 'transparent', transition: 'background var(--dur-fast) var(--ease)' }}>
      <Icon name={icon} size={15} color="var(--ink-1)" />{children}
    </div>
  );
}

/** Server-side folder browser: mono gold current path, directory list, create-here, select. */
export function FolderPicker({ path = '…', parent, dirs = [], error, onNavigate, onCreate, onPick, onClose }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  return (
    <Modal width={480} onClose={onClose}>
      <ModalHeader style={{ font: 'var(--fs-sm) var(--font-mono)', color: 'var(--brand)' }}>{path}</ModalHeader>
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {parent && <Row icon="parent" onClick={() => onNavigate?.(parent)}>..</Row>}
        {dirs.map((d) => (
          <Row key={d} icon="folder" onClick={() => onNavigate?.(`${path}${path.endsWith('/') ? '' : '/'}${d}`)}>{d}</Row>
        ))}
        {dirs.length === 0 && (
          <div style={{ padding: 'var(--sp-3)', color: 'var(--ink-2)', fontSize: 'var(--fs-sm)' }}>No subfolders.</div>
        )}
      </div>
      {creating && (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', padding: 'var(--sp-2) var(--sp-3)', borderTop: '1px solid var(--line)' }}>
          <TextInput autoFocus placeholder="New folder name" value={newName} onChange={setNewName}
            onKeyDown={(e) => { if (e.key === 'Enter') onCreate?.(newName); }} style={{ flex: 1 }} />
          <Button variant="good" onClick={() => onCreate?.(newName)}>Create</Button>
        </div>
      )}
      {error && (
        <div style={{ padding: '4px var(--sp-3)' }}>
          <Banner tone="error" inline style={{ fontSize: 'var(--fs-xs)' }}>{error}</Banner>
        </div>
      )}
      <ModalFooter>
        <Button icon="add" onClick={() => setCreating(!creating)} title="Create a subfolder here">New folder</Button>
        <span style={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={() => onPick?.(path)}>Select this folder</Button>
      </ModalFooter>
    </Modal>
  );
}
