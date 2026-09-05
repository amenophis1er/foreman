/**
 * Asking a human — the small mechanics shared by every place Foreman does it.
 *
 * Three surfaces ask: the director's `ask_human`, a permission prompt, and
 * the planner's `ask_user`. They differ in what they ask and what a good
 * unattended default is; they must not differ in the mechanics, because the
 * mechanics are where the rule lives: **every ask carries an unattended
 * default.** Foreman is an autonomous orchestrator, and a question that
 * blocks indefinitely turns a governance feature into an outage.
 */

/**
 * One structured question, the shape a picker renders.
 *
 * Options are what make a question fast to answer — a click instead of a
 * sentence — and putting the recommended one first is what makes the common
 * case one click. `multi` is for "which of these" questions; the default is a
 * single choice because most genuinely blocking questions are forks.
 */
export interface AskOption {
  label: string;
  /** One line under the label: what choosing this implies. */
  hint?: string;
}

export interface AskQuestion {
  question: string;
  options: AskOption[];
  multi?: boolean;
}

/** A batch of questions with one id, answered together. */
export interface PendingAsk {
  id: string;
  questions: AskQuestion[];
  askedAt: number;
}

/** Answers keyed by question text; a multi answer joins its labels with ", ". */
export type AskAnswers = Record<string, string>;

/**
 * Arms a timer that fires `onTimeout` once after `ms`, or never when `ms` is
 * zero. Trivial on purpose: the rule "0 disables, otherwise it fires" is worth
 * being explicit and testable, since forgetting the zero case would make a
 * per-run override of "never time out" silently time out anyway.
 */
export function armAskTimeout(ms: number, onTimeout: () => void): { cancel(): void } {
  if (!Number.isFinite(ms) || ms <= 0) return { cancel() { /* never armed */ } };
  let fired = false;
  const t = setTimeout(() => { fired = true; onTimeout(); }, ms);
  t.unref?.();
  return { cancel() { if (!fired) clearTimeout(t); } };
}

/**
 * Renders answers back to the agent as prose it cannot misread.
 *
 * The agent asked in structured form and gets a structured echo: question,
 * arrow, answer. An unanswered question is said to be unanswered rather than
 * omitted, so the agent does not assume silence meant agreement with its
 * recommended option.
 */
export function formatAnswers(questions: AskQuestion[], answers: AskAnswers): string {
  return questions
    .map((q) => {
      const a = answers[q.question];
      return `• ${q.question}\n  → ${a && a.trim() ? a.trim() : '(no answer — decide yourself)'}`;
    })
    .join('\n');
}

/** Validates and normalises what a model sent to an ask tool. */
export function normaliseQuestions(raw: unknown): AskQuestion[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: AskQuestion[] = [];
  for (const q of arr.slice(0, 3) as Array<Record<string, unknown>>) {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!question) continue;
    const options: AskOption[] = [];
    for (const o of (Array.isArray(q.options) ? q.options : []).slice(0, 6)) {
      if (typeof o === 'string' && o.trim()) options.push({ label: o.trim() });
      else if (o && typeof o === 'object' && typeof (o as AskOption).label === 'string') {
        const { label, hint } = o as AskOption;
        if (label.trim()) options.push({ label: label.trim(), hint: typeof hint === 'string' ? hint : undefined });
      }
    }
    // A question with fewer than two options is not a choice; it is a prompt
    // for free text, and the picker still offers "something else", so it is
    // kept rather than rejected — but a model that sends none is told so by
    // the tool's own validation upstream.
    out.push({ question, options, multi: q.multi === true });
  }
  return out;
}
