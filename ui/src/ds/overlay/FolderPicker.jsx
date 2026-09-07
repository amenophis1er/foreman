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
export function FolderPicker({ path = '…', parent, dirs = [], error, onNavigate, onCreate, onPick, onClone, clone, onClose }) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const cloning = clone?.state === 'running';
  return (
    <Modal width={480} onClose={onClose}>
      {/* A repository that is not here yet. It lands under the projects root
          by its own name and is linked when git is done; git runs as the
          user, with their keys and helpers, and Foreman never asks for a token. */}
      {onClone && (
        <div style={{ padding: 'var(--sp-3) var(--sp-3) var(--sp-2)', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', textTransform: 'uppercase', letterSpacing: '.06em' }}>From a Git repository</div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
            <TextInput placeholder="https://github.com/owner/repo, git@…, or owner/repo" value={url} onChange={setUrl} disabled={cloning}
              onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !cloning) onClone(url.trim(), branch.trim() || undefined); }} style={{ flex: 1 }} />
            <TextInput placeholder="branch" value={branch} onChange={setBranch} disabled={cloning} width={110}
              onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !cloning) onClone(url.trim(), branch.trim() || undefined); }} />
            <Button variant="good" disabled={!url.trim() || cloning} onClick={() => onClone(url.trim(), branch.trim() || undefined)}>{cloning ? 'Cloning…' : 'Clone & link'}</Button>
          </div>
          {clone?.state === 'running' && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {clone.progress || 'Starting git…'}{clone.dest ? ` → ${clone.dest}` : ''}
            </div>
          )}
          {clone?.state === 'error' && <Banner tone="error" inline style={{ fontSize: 'var(--fs-xs)' }}>{clone.error}</Banner>}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>Runs git as you, with your own keys and credential helpers. Or pick a folder that is already here:</div>
        </div>
      )}
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
