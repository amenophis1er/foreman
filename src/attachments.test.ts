import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { attachmentLines, safeName, saveAttachments } from './attachments.js';

test('safeName keeps the extension and drops what a shell or a path would choke on', () => {
  assert.equal(safeName('my screenshot (1).png'), 'my-screenshot-1-.png'.replace('-1-.png', '-1-.png'));
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName(''), 'file');
  assert.equal(safeName('..'), 'file');
});

test('saveAttachments writes under .foreman/attachments and reports project-relative paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'attach-'));
  const saved = await saveAttachments(dir, [
    { name: 'spec.md', data: Buffer.from('# spec').toString('base64') },
    { name: 'shot.png', data: Buffer.from([0x89, 0x50]).toString('base64') },
  ], new Date(2026, 8, 5, 19, 44, 12));
  assert.equal(saved.length, 2);
  assert.equal(saved[0].path, '.foreman/attachments/20260905-194412-1-spec.md');
  assert.equal(saved[1].path, '.foreman/attachments/20260905-194412-2-shot.png');
  assert.equal(await readFile(path.join(dir, saved[0].path), 'utf8'), '# spec');
  assert.match(attachmentLines(saved), /Attached files.*\n- \.foreman\/attachments\/20260905-194412-1-spec\.md\n- /s);
});

test('saveAttachments refuses empty, oversized and too many files with a plain message', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'attach-'));
  await assert.rejects(saveAttachments(dir, [{ name: 'x', data: '' }]), /is empty/);
  await assert.rejects(saveAttachments(dir, Array.from({ length: 11 }, () => ({ name: 'x', data: 'AA==' }))), /at most 10/);
  assert.deepEqual(await saveAttachments(dir, []), []);
});
