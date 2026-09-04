/**
 * `/Users/you/Projects/a/b/c` → `~/Projects/…/b/c`.
 *
 * Shared by the header's folder pill and the fleet card so one project's path
 * reads identically wherever it appears. Callers always keep the full path in
 * a `title`, since the elision is for scanning, not for hiding.
 */
export function shortPath(p) {
  if (!p) return '';
  let s = String(p).replace(/^\/(Users|home)\/[^/]+/, '~');
  const parts = s.split('/');
  if (parts.length > 4) s = [parts[0], parts[1], '…', ...parts.slice(-2)].join('/');
  return s;
}
