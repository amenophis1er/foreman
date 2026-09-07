/**
 * How much request body Foreman will read, and what a bad one costs.
 *
 * Every route reads its JSON into memory. Without a cap, one request with a
 * long-running body holds the process's whole heap hostage — no authentication
 * stands between a stray script and that, and the operator's other missions
 * die with the server. So there is a cap, and exceeding it is a 413 rather
 * than an OOM.
 *
 * The cap is per route rather than global because one route is legitimately
 * huge: attachments arrive base64-encoded inside the JSON body, and
 * `src/attachments.ts` already allows ten files of 10 MiB each — roughly
 * 133 MiB on the wire once base64 has added its third. Every other route
 * carries a mission brief or a settings object, which 1 MiB covers many times
 * over.
 */

/** Enough for any brief, settings blob or model list; small enough to be free. */
export const DEFAULT_BODY_LIMIT = 1 * 1024 * 1024;

/** Ten 10 MiB files, base64-inflated, plus room for the JSON around them. */
export const ATTACHMENT_BODY_LIMIT = 128 * 1024 * 1024;

/** A body problem with the answer already decided: 400 for junk, 413 for too much. */
export class BodyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'BodyError';
  }
}

/** The cap for this route: the large one only where large bodies are the point. */
export function bodyLimitFor(method: string | undefined, pathname: string): number {
  const m = (method ?? '').toUpperCase();
  return m === 'POST' && pathname === '/attachments' ? ATTACHMENT_BODY_LIMIT : DEFAULT_BODY_LIMIT;
}

/**
 * The body as an object. An empty body is `{}` (routes read optional fields
 * off it and validate for themselves), and so is valid JSON that is not one —
 * an array, a number or a bare string has none of the named fields the
 * handlers destructure, so it is the empty object as far as they can tell.
 * Only unparseable input is an error, and it is the client's: 400, not a 500
 * whose body is the text of a `SyntaxError`.
 */
export function parseBody(buf: Buffer | string): Record<string, unknown> {
  const text = typeof buf === 'string' ? buf : buf.toString();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError(400, 'invalid JSON body');
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>) : {};
}
