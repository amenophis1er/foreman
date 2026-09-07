import React, { useEffect, useState } from 'react';
import { Modal, ModalHeader, ModalFooter } from './Modal';
import { Button } from '../core/Button';
import { Icon } from '../core/Icon';
import { TextInput } from '../forms/TextInput';
import { Banner } from '../status/Banner';
import { Tabs } from '../core/Tabs';

function Row({ children, icon, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div role="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', cursor: 'pointer', fontSize: 'var(--fs-md)', background: hover ? 'var(--bg-card)' : 'transparent', transition: 'background var(--dur-fast) var(--ease)' }}>
      <Icon name={icon} size={15} color="var(--ink-1)" />{children}
    </div>
  );
}

/**
 * Links a project. Two ways in, one at a time: a folder already on this
 * machine, or a Git repository that is not here yet. Each tab says where the
 * project will live before anything is clicked — the browser shows the path
 * it is in, the Git tab shows the path the clone will land in.
 */
export function FolderPicker({ path = '…', parent, dirs = [], error, onNavigate, onCreate, onPick, onClone, cloneWhere, clone, onClose }) {
  const [mode, setMode] = useState('folder');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [where, setWhere] = useState(null);
  const cloning = clone?.state === 'running';
  const canClone = Boolean(url.trim()) && Boolean(where?.dest) && !cloning;

  // The destination, from the server, as the URL is typed: the same check
  // the clone itself runs, so what it says is what will happen.
  useEffect(() => {
    if (!cloneWhere) return;
    const u = url.trim();
    if (!u) { setWhere(null); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.resolve(cloneWhere(u)).then((w) => { if (!cancelled) setWhere(w); }).catch(() => { if (!cancelled) setWhere(null); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [url, cloneWhere]);

  const startClone = () => { if (canClone) onClone?.(url.trim(), branch.trim() || undefined); };
  const git = mode === 'git' && onClone;

  return (
    <Modal width={520} onClose={cloning ? undefined : onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-3) var(--sp-2)' }}>
        <span style={{ fontWeight: 'var(--fw-semibold)' }}>Link a project</span>
        {onClone && (
          <Tabs size="sm" value={mode} onChange={(v) => { if (!cloning) setMode(v); }} style={{ marginLeft: 'auto' }} tabs={[
            { value: 'folder', label: 'Folder on this machine', icon: 'folder' },
            { value: 'git', label: 'Git repository', icon: 'provider' },
          ]} />
        )}
      </div>

      {git ? (
        <div style={{ padding: '0 var(--sp-3) var(--sp-3)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>Repository</label>
            <TextInput autoFocus placeholder="https://github.com/owner/repo · git@host:owner/repo.git · owner/repo" value={url} onChange={setUrl} disabled={cloning}
              onKeyDown={(e) => { if (e.key === 'Enter') startClone(); }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-2)' }}>Branch <span style={{ color: 'var(--ink-3, var(--ink-2))' }}>· optional, the default branch otherwise</span></label>
            <TextInput placeholder="main" value={branch} onChange={setBranch} disabled={cloning} width={220}
              onKeyDown={(e) => { if (e.key === 'Enter') startClone(); }} />
          </div>
          {/* Where it lands, said before the click. */}
          <div style={{ padding: 'var(--sp-2) var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', fontSize: 'var(--fs-xs)', color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {!url.trim() && <span>Will be cloned under your projects root and linked as a project. Paste a URL to see the exact folder.</span>}
            {url.trim() && where?.dest && (
              <span>Will be cloned to <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--brand)' }}>{where.dest}</span> and linked as <b style={{ color: 'var(--ink-1)' }}>{where.name}</b>.</span>
            )}
            {url.trim() && where && !where.dest && <span style={{ color: 'var(--status-error)' }}>{where.error}</span>}
            {url.trim() && !where && <span>Checking…</span>}
            <span>Runs <span style={{ fontFamily: 'var(--font-mono)' }}>git clone</span> as you, with your own SSH keys and credential helpers. Foreman never asks for a token. Full clone, so the deck can diff against it.</span>
          </div>
          {clone?.state === 'running' && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-1)', fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {clone.progress || 'Starting git…'}
            </div>
          )}
          {clone?.state === 'error' && <Banner tone="error" inline style={{ fontSize: 'var(--fs-xs)' }}>{clone.error}</Banner>}
        </div>
      ) : (
        <>
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
        </>
      )}

      <ModalFooter>
        {git ? null : <Button icon="add" onClick={() => setCreating(!creating)} title="Create a subfolder here">New folder</Button>}
        <span style={{ flex: 1 }} />
        <Button onClick={onClose} disabled={cloning}>Cancel</Button>
        {git
          ? <Button variant="primary" disabled={!canClone} onClick={startClone}>{cloning ? 'Cloning…' : 'Clone & link'}</Button>
          : <Button variant="primary" onClick={() => onPick?.(path)}>Select this folder</Button>}
      </ModalFooter>
    </Modal>
  );
}
