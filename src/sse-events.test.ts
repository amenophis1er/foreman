/**
 * Every event the server emits must be one the client listens for.
 *
 * An EventSource delivers only the named events it has a listener for. A
 * name the server emits but the client never subscribed to is not an error
 * anywhere — the frame arrives, is dropped, and the UI shows it only after a
 * reload replays the log. Thirteen events shipped that way in a single day,
 * each looking fine on replay, before a human noticed a picker that never
 * appeared. This test is the contract that stops it recurring: emit a new
 * name, and `SSE_EVENTS` in ui/src/sse.ts must grow in the same change.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = here;
const SSE_TS = path.resolve(here, '..', 'ui', 'src', 'sse.ts');

/** Server files that can emit: everything under src/ except tests and the ported gateway. */
function serverFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'gateway') continue; // proxies bytes; emits nothing to the UI
      out.push(...serverFiles(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Names passed as the first argument to an emitter. Matches the shapes in use:
 * `this.emit('x'`, `turn.emit('x'`, `emit('x'`, `makeChatEmitter(id)('x'`,
 * `broadcastChat(id, 'x'` (a frame without a log line), and
 * the ternary `emit(isResume ? 'run_resumed' : 'run_started'` — the whole
 * first-argument expression is taken and every quoted name in it counts. A
 * name assembled from strings would not be caught; none exist, and the
 * comment on SSE_EVENTS says not to start.
 */
function emittedNames(): Set<string> {
  const names = new Set<string>();
  const re = /(?:\bemit|makeChatEmitter\([^)]*\))\(\s*([^,]+),|\bbroadcastChat\(\s*[^,]+,\s*([^,]+),/g;
  for (const file of serverFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(re)) {
      for (const q of (m[1] ?? m[2] ?? '').matchAll(/'([a-z_]+)'/g)) names.add(q[1]);
    }
  }
  return names;
}

function subscribedNames(): Set<string> {
  const text = readFileSync(SSE_TS, 'utf8');
  const block = text.slice(text.indexOf('SSE_EVENTS = ['), text.indexOf('] as const'));
  return new Set([...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

test('every event the server emits has a client listener', () => {
  const emitted = emittedNames();
  const subscribed = subscribedNames();
  assert.ok(emitted.size > 20, `sanity: expected to find many emits, found ${emitted.size}`);
  const missing = [...emitted].filter((n) => !subscribed.has(n)).sort();
  assert.deepEqual(missing, [],
    `emitted by the server but never delivered to the UI (add to SSE_EVENTS in ui/src/sse.ts): ${missing.join(', ')}`);
});

test('the client does not listen for names nothing emits', () => {
  // The reverse is only a hygiene check, so it warns through the message
  // rather than failing on a name emitted from somewhere this scan cannot see.
  const emitted = emittedNames();
  const subscribed = subscribedNames();
  const dead = [...subscribed].filter((n) => !emitted.has(n)).sort();
  // Known: `models_changed` is emitted from a place outside the emit() shapes
  // (a server broadcast helper). Anything else is worth a look.
  const unexplained = dead.filter((n) => n !== 'models_changed');
  assert.deepEqual(unexplained, [], `subscribed but apparently never emitted: ${unexplained.join(', ')}`);
});
