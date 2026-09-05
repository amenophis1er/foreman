/**
 * The gateway's token ledger — a Foreman-owned wrapper around the ported
 * llm-gateway.
 *
 * WHY THIS IS A SEPARATE FILE. `llm-gateway.cjs` is a verbatim copy from a
 * sibling project, and the Step 2 decision was that it stays one so re-syncing
 * is a `cp` and its upstream test suite keeps applying. Counting tokens needs
 * the request (which run is this?) and the response (how many tokens?), which
 * is exactly the request path that decision refused to edit. So this binds the
 * socket instead, and hands each request to the ported handler untouched.
 *
 * WHY IT EXISTS AT ALL. An OpenAI-compatible endpoint reports usage only on
 * the *final* chunk of a stream, and the SDK only surfaces it on the `result`
 * message that ends a turn. A director in one long turn — every tool call,
 * every file write, one turn — therefore shows `0 tok` for minutes while
 * really having spent a hundred thousand. The gateway is the only place that
 * sees the numbers as they flow.
 *
 * ATTRIBUTION. Foreman points each agent at `.../run/<key>`, and the Agent SDK
 * preserves that prefix (measured, not assumed: it sends
 * `POST /run/<key>/v1/messages?beta=true`). The key carries the resume attempt
 * as well as the run id, so a resumed run starts a fresh bucket and its
 * persisted total is never counted twice by a gateway that outlived it.
 */
const http = require('node:http');
const gateway = require('./llm-gateway.cjs');

const PORT = Number(process.env.LLM_GATEWAY_PORT || 0);
const MODE = process.env.LLM_GATEWAY_MODE || 'openai';

/** key -> running totals. In memory: a restarted gateway has counted nothing. */
const ledger = new Map();

const empty = () => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0,
});

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * Fold one response's usage into a key's total.
 *
 * `costUsd` is only ever recorded when the upstream states it (OpenRouter
 * does, per response). Foreman never derives one here — a gateway inventing a
 * dollar figure is the precise failure the cost basis exists to prevent.
 */
function record(key, usage, costUsd) {
  if (!key || !usage) return;
  const t = ledger.get(key) ?? empty();
  t.inputTokens += n(usage.input_tokens ?? usage.prompt_tokens);
  t.outputTokens += n(usage.output_tokens ?? usage.completion_tokens);
  t.cacheReadTokens += n(usage.cache_read_input_tokens);
  t.cacheWriteTokens += n(usage.cache_creation_input_tokens);
  t.calls += 1;
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) {
    t.costUsd = (t.costUsd ?? 0) + costUsd;
  }
  ledger.set(key, t);
}

/**
 * Pull usage out of whatever the handler wrote back.
 *
 * Two shapes reach here and both are handled by looking for the same field
 * rather than by knowing which mode produced it: a single JSON body carrying
 * `usage`, or an SSE stream whose `message_delta` frame carries it at the end.
 * Anything unparseable is skipped in silence — a ledger is an observation, and
 * must never be able to fail a request it is only watching.
 */
function extractUsage(body) {
  if (!body.includes('"usage"')) return null;
  let found = null;
  let cost;
  const consider = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.usage && typeof obj.usage === 'object') {
      // The last usage object wins: a stream's closing `message_delta` is
      // more complete than anything before it.
      found = obj.usage;
      if (typeof obj.usage.cost === 'number') cost = obj.usage.cost;
    }
  };
  if (body.startsWith('data:') || body.includes('\ndata:')) {
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { consider(JSON.parse(payload)); } catch { /* partial frame */ }
    }
  } else {
    try { consider(JSON.parse(body)); } catch { /* not json */ }
  }
  return found ? { usage: found, costUsd: cost } : null;
}

/**
 * Watch a response without changing it.
 *
 * Chunks are buffered only while they could still contain a usage object, and
 * the buffer is capped: a ledger must not turn a long streamed answer into
 * unbounded memory. Every write is passed straight through first, so nothing
 * here can delay or alter what the agent receives.
 */
function tee(res, key) {
  const { write, end } = res;
  let buf = '';
  const CAP = 256 * 1024;
  const absorb = (chunk) => {
    if (!chunk || buf.length > CAP) return;
    // Buffer.from, not chunk.toString(): a Uint8Array's own toString() ignores
    // the encoding and yields "101,118,101,..." — comma-separated byte values
    // that parse as nothing and would silently record zero tokens forever.
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  };
  res.write = function (chunk, ...rest) {
    absorb(chunk);
    return write.call(this, chunk, ...rest);
  };
  res.end = function (chunk, ...rest) {
    absorb(chunk);
    try {
      const got = extractUsage(buf);
      if (got) record(key, got.usage, got.costUsd);
    } catch { /* never fail a response over bookkeeping */ }
    return end.call(this, chunk, ...rest);
  };
}

function startServer() {
  const handler = MODE === 'passthrough' ? gateway.handlePassthrough
    : MODE === 'codex' ? gateway.handleCodex
    : gateway.handleOpenAI;

  const server = http.createServer((req, res) => {
    // Foreman's own read side. Never proxied upstream.
    if (req.method === 'GET' && req.url.startsWith('/_foreman/usage')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.fromEntries(ledger)));
      return;
    }

    // Strip the run key so the ported handler sees the path it expects. An
    // unkeyed request still works and is simply not attributed — a gateway
    // that refused traffic it could not label would turn a bookkeeping
    // feature into an outage.
    const m = /^\/run\/([^/]+)(\/.*)$/.exec(req.url || '');
    const key = m ? decodeURIComponent(m[1]) : null;
    if (m) req.url = m[2];
    if (key) tee(res, key);

    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: String((e && e.message) || e) },
      }));
    });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') process.exit(0);
    throw e;
  });
  server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    process.stdout.write(
      `llm-gateway (${MODE}) listening on 127.0.0.1:${addr.port} -> ${process.env.LLM_GATEWAY_TARGET_URL}\n`,
    );
  });
}

module.exports = { extractUsage, record, ledger, tee };

if (require.main === module) startServer();
