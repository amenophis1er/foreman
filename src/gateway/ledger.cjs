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
 *
 * REQUEST DUMPS. Set FOREMAN_GATEWAY_DUMP_DIR and every POST to /v1/messages
 * is written to disk, request and response outcome, before it is served. This
 * exists because a stall was only ever reproducible with the real worker
 * payload — the SDK's full system prompt plus its whole tool set — and no
 * hand-built request came close. The only honest way to replay it is to have
 * kept it. Off by default: the files hold prompts and repository contents.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const gateway = require('./llm-gateway.cjs');

const PORT = Number(process.env.LLM_GATEWAY_PORT || 0);
const MODE = process.env.LLM_GATEWAY_MODE || 'openai';
const DUMP_DIR = process.env.FOREMAN_GATEWAY_DUMP_DIR || '';

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
 *
 * `observe`, when given, is told the outcome once at end — status, timing,
 * size, whether usage ever appeared. The dumper hangs off this rather than
 * wrapping `res` a second time: two observers patching write/end would each
 * see the other's wrapper, and a bug in either would be twice as hard to place.
 */
function tee(res, key, observe) {
  const { write, end } = res;
  let buf = '';
  let bytes = 0;
  let firstByteMs = null;
  const started = Date.now();
  const CAP = 256 * 1024;
  const absorb = (chunk) => {
    if (!chunk) return;
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (len > 0 && firstByteMs === null) firstByteMs = Date.now() - started;
    bytes += len;
    if (buf.length > CAP) return;
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
    let sawUsage = false;
    try {
      const got = extractUsage(buf);
      sawUsage = !!got;
      if (got && key) record(key, got.usage, got.costUsd);
    } catch { /* never fail a response over bookkeeping */ }
    if (observe) {
      try {
        observe({
          status: res.statusCode, durationMs: Date.now() - started, bytes, sawUsage, firstByteMs,
        });
      } catch { /* an observer is not allowed to fail the response either */ }
    }
    return end.call(this, chunk, ...rest);
  };
}

/** Header copy safe to write to disk: the two places a credential travels. */
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = /^(x-api-key|authorization)$/i.test(k) ? '[redacted]' : v;
  }
  return out;
}

/**
 * The few numbers that tell a stalled request apart from a healthy one at a
 * glance, without opening a multi-megabyte file. `system` is a string or an
 * array of text blocks depending on the SDK version; both are measured.
 */
function summarize(body, bodyBytes) {
  const s = { model: null, stream: null, systemChars: 0, toolCount: 0, messageCount: 0, bodyBytes };
  if (!body || typeof body !== 'object') return s;
  s.model = typeof body.model === 'string' ? body.model : null;
  s.stream = !!body.stream;
  if (typeof body.system === 'string') s.systemChars = body.system.length;
  else if (Array.isArray(body.system)) {
    for (const b of body.system) if (b && typeof b.text === 'string') s.systemChars += b.text.length;
  }
  if (Array.isArray(body.tools)) s.toolCount = body.tools.length;
  if (Array.isArray(body.messages)) s.messageCount = body.messages.length;
  return s;
}

/**
 * Build the request dumper, or nothing when the directory is unset.
 *
 * `begin` writes the request file and returns the function that writes its
 * response file; both swallow everything. A dump is a diagnostic aid bolted
 * onto the request path, and the one thing worse than a missing dump is a
 * worker that failed because its gateway could not write a file.
 */
function makeDumper(dir, log = (line) => process.stderr.write(`${line}\n`)) {
  if (!dir) return null;
  let seq = 0;
  let made = false;
  return {
    dir,
    begin(key, req, raw) {
      try {
        if (!made) { fs.mkdirSync(dir, { recursive: true }); made = true; }
        const ts = new Date();
        // The key is `<runId>.<attempt>`-ish but comes off the wire; keep the
        // filename to characters every filesystem accepts.
        const safeKey = String(key ?? 'unkeyed').replace(/[^A-Za-z0-9._-]/g, '_');
        const name = `${ts.toISOString().replace(/[:.]/g, '-')}-${safeKey}-${++seq}`;
        const text = Buffer.from(raw).toString('utf8');
        let body = text;
        try { body = JSON.parse(text); } catch { /* keep the raw string: a bad body is the finding */ }
        const summary = summarize(body, raw.length);
        fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
          ts: ts.toISOString(), key, url: req.url, headers: redactHeaders(req.headers), body, summary,
        }));
        const label = key ?? 'unkeyed';
        log(`[dump] ${label} -> ${summary.model} tools=${summary.toolCount} system=${summary.systemChars} stream=${summary.stream}`);
        return (info) => {
          try {
            fs.writeFileSync(path.join(dir, `${name}.response.json`), JSON.stringify(info));
            log(`[dump] ${label} <- ${info.status} in ${info.durationMs}ms ${info.bytes}B usage=${info.sawUsage}`);
          } catch { /* see above */ }
        };
      } catch {
        return () => {};
      }
    },
  };
}

/** Drain a request into memory. */
function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * A stand-in request the handler cannot tell from the original.
 *
 * The body has been drained to dump it, so the handler gets a stream that
 * plays it back. Sharing a 'data' listener with the handler instead would
 * work today only because each handler subscribes before its first `await`
 * — an ordering inside a verbatim upstream file that a re-sync may not
 * keep, and whose failure mode is a silently truncated prompt. The handlers
 * read exactly headers, method, url, on and pipe (measured, not assumed).
 */
function replay(req, raw) {
  const r = new Readable({ read() {} });
  r.headers = req.headers;
  r.method = req.method;
  r.url = req.url;
  r.push(raw);
  r.push(null);
  return r;
}

function startServer() {
  const handler = MODE === 'passthrough' ? gateway.handlePassthrough
    : MODE === 'codex' ? gateway.handleCodex
    : gateway.handleOpenAI;
  const dumper = makeDumper(DUMP_DIR);
  if (dumper) process.stderr.write(`[dump] writing /v1/messages requests to ${dumper.dir}\n`);

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

    const wantDump = !!dumper && req.method === 'POST' && (req.url || '').startsWith('/v1/messages');
    // Assigned once the request file is written; the tee calls it at end.
    let finishDump = () => {};
    if (key || wantDump) tee(res, key, wantDump ? (info) => finishDump(info) : undefined);

    const fail = (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: String((e && e.message) || e) },
      }));
    };
    if (wantDump) {
      // Drain, dump, then serve from the replay. The undumped path below is
      // untouched: the handler still gets the live socket stream.
      readAll(req).then((raw) => {
        finishDump = dumper.begin(key, req, raw);
        return handler(replay(req, raw), res);
      }).catch(fail);
    } else {
      Promise.resolve(handler(req, res)).catch(fail);
    }
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

module.exports = {
  extractUsage, record, ledger, tee, makeDumper, summarize, redactHeaders, replay,
};

if (require.main === module) startServer();
