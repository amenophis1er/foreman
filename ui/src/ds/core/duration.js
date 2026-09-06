/**
 * How long something took, in the shortest form a person reads at a glance.
 *
 * Seconds under a minute (a fast run is not "0m"), minutes under an hour,
 * hours and minutes above. Wall clock is the one cost a free local model
 * still charges, so this is not a decoration — on an unpriced run it is the
 * headline number.
 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
