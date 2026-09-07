// The deck: what a run changed and what it produced, read from
// `GET /runs/{id}/deck`. Read-only by design (a non-goal: no editor, no file manager) — this file
// fetches, it never writes.
import { useCallback, useEffect, useState } from 'react';

export interface DeckFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary?: boolean;
  /** Unified diff text. Absent for binaries and deletions the server chose not to expand. */
  diff?: string;
  /** The diff was cut at the server's line cap (first 400 lines). */
  truncated?: boolean;
  /** The file was already dirty before the run started — not all of this is the crew's. */
  preexisting?: boolean;
}

export interface DeckArtifact {
  path: string;
  kind: 'image' | 'text' | 'pdf' | 'other';
  size: number;
  mtimeMs: number;
}

export interface Deck {
  runId: string;
  baseline: { kind: 'git' | 'snapshot' | 'none'; at?: number; head?: string | null };
  files: DeckFile[];
  artifacts: DeckArtifact[];
  totals: { files: number; additions: number; deletions: number };
  /** The server's caveat, when it has one ("no baseline — showing the working tree"). */
  note?: string;
}

export interface DeckState {
  deck: Deck | null;
  /** True only for the first fetch of a run; refreshes are silent. */
  loading: boolean;
  /** Transport or server error text. Distinct from `missing`. */
  error: string | null;
  /** The endpoint answered 404: no deck for this run (or the server predates decks). */
  missing: boolean;
  refresh: () => void;
}

const LIVE_INTERVAL_MS = 15_000;

/**
 * The deck for one run.
 *
 * Fetched on mount and every 15s while `running` — a diff of a moving tree
 * is only useful if it moves too, but the endpoint walks the folder, so it
 * is not polled at transcript speed. A finished run is fetched once; its
 * tree is not going to change on Foreman's account.
 */
export function useDeck(runId: string | null, running: boolean): DeckState {
  const [deck, setDeck] = useState<Deck | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    setDeck(null); setError(null); setMissing(false);
    if (!runId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      const r = await fetch(`/runs/${encodeURIComponent(runId)}/deck`).catch(() => null);
      if (cancelled) return;
      if (!r) { setError('Could not reach the server.'); setLoading(false); return; }
      if (r.status === 404) { setMissing(true); setError(null); setLoading(false); return; }
      if (!r.ok) {
        const body = await r.json().catch(() => ({} as { error?: string }));
        setError(body.error || `HTTP ${r.status}`); setLoading(false); return;
      }
      const d = await r.json().catch(() => null) as Deck | null;
      if (cancelled) return;
      if (d) { setDeck(d); setMissing(false); setError(null); }
      setLoading(false);
    };

    void load();
    const timer = running ? setInterval(() => void load(), LIVE_INTERVAL_MS) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, running, tick]);

  return { deck, loading, error, missing, refresh };
}

/** The project's working tree as it stands, from `GET /projects/{id}/tree`. Fetched once per mount; `refresh` re-reads. */
export function useProjectTree(projectId: string | null): { files: DeckArtifact[]; truncated: boolean; loading: boolean; error: string | null; refresh: () => void } {
  const [files, setFiles] = useState<DeckArtifact[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    setFiles([]); setError(null);
    if (!projectId) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/projects/${encodeURIComponent(projectId)}/tree`).then(async (r) => {
      if (cancelled) return;
      if (!r.ok) { setError((await r.json().catch(() => ({} as { error?: string }))).error || `HTTP ${r.status}`); return; }
      const d = await r.json() as { files: DeckArtifact[]; truncated: boolean };
      setFiles(d.files ?? []); setTruncated(Boolean(d.truncated));
    }).catch(() => { if (!cancelled) setError('Could not reach the server.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, tick]);
  return { files, truncated, loading, error, refresh };
}
