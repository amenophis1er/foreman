/**
 * Ollama host resolution and the zero-config provider.
 *
 * Model listing moved to models.test.ts when it stopped being Ollama-specific;
 * what is left here is only what is genuinely about the daemon.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ollamaHost, ollamaProvider } from './ollama.js';

async function withHost<T>(host: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OLLAMA_HOST;
  if (host === undefined) delete process.env.OLLAMA_HOST;
  else process.env.OLLAMA_HOST = host;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = saved;
  }
}

test('OLLAMA_HOST is honoured, however it is written', async () => {
  await withHost(undefined, async () => assert.equal(ollamaHost(), 'http://127.0.0.1:11434'));
  // The bare host:port form is the one Ollama's own docs use.
  await withHost('127.0.0.1:9999', async () => assert.equal(ollamaHost(), 'http://127.0.0.1:9999'));
  await withHost('http://box.local:1234/', async () => assert.equal(ollamaHost(), 'http://box.local:1234'));
  await withHost('https://ollama.example', async () => assert.equal(ollamaHost(), 'https://ollama.example'));
});

test('the discovered provider needs no credential and no configuration', async () => {
  await withHost('127.0.0.1:11434', async () => {
    const p = ollamaProvider('qwen3:8b');
    assert.equal(p.kind, 'openai-compatible');
    assert.ok(!('apiKeyEnv' in p) || p.apiKeyEnv === undefined,
      'a daemon has no key — including for :cloud, which it signs for itself');
    assert.equal(p.baseUrl, 'http://127.0.0.1:11434');
    assert.equal(p.model, 'qwen3:8b');
  });
});

test('a project can point at a daemon on another machine', async () => {
  // The whole point of a per-project host: the server's own OLLAMA_HOST must
  // not decide what another project talks to.
  await withHost('127.0.0.1:11434', async () => {
    const p = ollamaProvider('glm-5.3-flash:cloud', 'http://box.tailnet:11434');
    assert.equal(p.baseUrl, 'http://box.tailnet:11434');
  });
});
