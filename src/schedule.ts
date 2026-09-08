/**
 * When does a schedule fire next.
 *
 * Two callers ask that question — the server's ticker, deciding whether a
 * scheduled mission is due, and the preview route behind the UI's "next three
 * runs". If they disagreed by so much as a minute the UI would be lying about
 * something the user cannot otherwise see, so both go through this module and
 * nothing else computes a firing time.
 *
 * Three deliberate positions:
 *  - No cron dependency. Five fields with `*`, lists, ranges and steps is an
 *    afternoon's work and a well-tested one; a package here would be a supply
 *    chain and an upgrade treadmill for a parser that never changes.
 *  - Everything is the machine's LOCAL time, computed with local Date fields.
 *    "daily 07:30" means what the person who typed it sees on the wall clock,
 *    which is not a fixed number of hours after midnight UTC.
 *  - Interval cadence is elapsed-time arithmetic instead, so "every 6 hours"
 *    stays every 6 hours through a DST change rather than gaining or losing
 *    one. Wall-clock cadences keep the wall-clock promise; that is the whole
 *    difference between them.
 *
 * Every search is capped (see MAX_SCAN_DAYS): an expression like `0 0 30 2 *`
 * — February 30th — is legal to write and never happens, and a ticker must
 * answer null for it rather than spin.
 */

export type Cadence =
  | { kind: 'daily'; at: string }               // 'HH:MM', machine local time
  | { kind: 'weekly'; day: number; at: string }  // day 0=Sunday..6=Saturday
  | { kind: 'interval'; everyMinutes: number }   // minimum 60
  | { kind: 'cron'; expr: string };             // five fields: min hour dom mon dow

/** Parsed cron fields, each an ascending list of the values it matches. */
export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** Was day-of-month something other than `*`? Decides the OR rule below. */
  domRestricted: boolean;
  /** Was day-of-week something other than `*`? */
  dowRestricted: boolean;
}

/** 'HH:MM' on a 24-hour clock, and nothing else. */
const AT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * How far ahead a search will look before giving up. Five years is far past
 * any schedule anyone would wait for, and it bounds the impossible ones
 * (Feb 30, "the 31st of a 30-day month only") to a few thousand cheap checks.
 */
const MAX_SCAN_DAYS = 366 * 5;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One cron field's name and legal range, for parsing and for error wording. */
interface FieldSpec { name: string; min: number; max: number }

const FIELD_SPECS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 7 is accepted below and folded onto 0; both spellings of Sunday are in use.
  { name: 'day-of-week', min: 0, max: 7 },
];

/** A whole number, written plainly — no '1e3', no '  5 ', no '+5'. */
function intOrNull(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  const n = Number(token);
  return Number.isSafeInteger(n) ? n : null;
}

/** One value in a field: in range or a named complaint. */
function valueIn(token: string, spec: FieldSpec): number {
  const n = intOrNull(token);
  if (n === null || n < spec.min || n > spec.max) {
    throw new Error(`${spec.name}: ${JSON.stringify(token)} is out of range ${spec.min}-${spec.max}`);
  }
  return n;
}

// One comma-separated term: `*`, `5`, `1-5`, `*/15`, `10-50/10`, `5/15`.
function parseTerm(term: string, spec: FieldSpec): number[] {
  const [body, stepText, ...rest] = term.split('/');
  if (rest.length) throw new Error(`${spec.name}: ${JSON.stringify(term)} has more than one step`);

  let step = 1;
  if (stepText !== undefined) {
    const s = intOrNull(stepText);
    if (s === null || s < 1) throw new Error(`${spec.name}: step ${JSON.stringify(stepText)} must be a whole number of 1 or more`);
    step = s;
  }

  let lo: number;
  let hi: number;
  if (body === '*') {
    lo = spec.min;
    hi = spec.max;
  } else if (body.includes('-')) {
    const [a, b, ...more] = body.split('-');
    if (more.length) throw new Error(`${spec.name}: ${JSON.stringify(body)} is not a range`);
    lo = valueIn(a, spec);
    hi = valueIn(b, spec);
    if (lo > hi) throw new Error(`${spec.name}: range ${JSON.stringify(body)} runs backwards`);
  } else {
    lo = valueIn(body, spec);
    // `5/15` is Vixie cron's "from 5 to the end of the field, every 15" — a
    // bare value with no step is just itself.
    hi = stepText === undefined ? lo : spec.max;
  }

  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

/**
 * Parses a five-field cron expression, or throws with a reason a person can
 * act on. It throws rather than returning null because every caller either
 * has already validated the expression or wants the reason: a bad expression
 * that quietly became "never runs" is the failure mode worth designing out.
 */
export function parseCron(expr: string): CronFields {
  const fields = String(expr ?? '').trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error(`a cron expression has five fields (minute hour day-of-month month day-of-week), got ${fields.length}`);
  }

  const parsed = fields.map((field, i) => {
    const spec = FIELD_SPECS[i];
    const values = new Set<number>();
    for (const term of field.split(',')) {
      if (!term) throw new Error(`${spec.name}: ${JSON.stringify(field)} has an empty item`);
      // Sunday is 0 or 7; fold so membership tests only ever see 0.
      for (const v of parseTerm(term, spec)) values.add(spec.name === 'day-of-week' && v === 7 ? 0 : v);
    }
    return [...values].sort((a, b) => a - b);
  });

  return {
    minutes: parsed[0],
    hours: parsed[1],
    daysOfMonth: parsed[2],
    months: parsed[3],
    daysOfWeek: parsed[4],
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/**
 * Does this local date match the cron day fields?
 *
 * The OR is not a shortcut. Standard cron treats day-of-month and day-of-week
 * as alternatives whenever both are restricted, so `0 0 1 * 1` means "the 1st
 * of the month AND every Monday", not "Mondays that fall on the 1st". People
 * write `0 9 * * 1-5` and `0 9 1 * *` expecting exactly that, and a schedule
 * that fired on neither would look broken.
 */
function dayMatches(d: Date, c: CronFields): boolean {
  if (!c.months.includes(d.getMonth() + 1)) return false;
  const dom = c.daysOfMonth.includes(d.getDate());
  const dow = c.daysOfWeek.includes(d.getDay());
  if (c.domRestricted && c.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * The first local wall-clock instant strictly after `after` on a matching day
 * at a matching hour and minute, or null within the scan cap.
 *
 * The candidate is built with local Date fields and taken as the Date
 * constructor normalises it. On a spring-forward day 02:30 does not exist and
 * normalises to 03:30 local — a real instant, a minute late, which is what a
 * daily 02:30 schedule should do rather than skip the day or loop looking for
 * a time the clock never shows.
 */
function nextWallClock(after: Date, c: CronFields): Date | null {
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  // Firings are strictly after `after`, and rounded to the minute: from
  // 09:00:30 the next 09:00 candidate is tomorrow's, not this second's.
  cursor.setMinutes(cursor.getMinutes() + 1);

  let day = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned++) {
    if (dayMatches(day, c)) {
      const sameDay = day.getFullYear() === cursor.getFullYear()
        && day.getMonth() === cursor.getMonth()
        && day.getDate() === cursor.getDate();
      for (const h of c.hours) {
        if (sameDay && h < cursor.getHours()) continue;
        for (const m of c.minutes) {
          if (sameDay && h === cursor.getHours() && m < cursor.getMinutes()) continue;
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
          if (at.getTime() > after.getTime()) return at;
        }
      }
    }
    // Step by noon rather than midnight: adding 24 h to a midnight that a DST
    // change moved can land back on the same date and stall the scan.
    const nextDay = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, 0, 0);
    nextDay.setDate(nextDay.getDate() + 1);
    day = new Date(nextDay.getFullYear(), nextDay.getMonth(), nextDay.getDate());
  }
  return null;
}

/** The 'HH:MM' of a validated `at`, as numbers. */
function splitAt(at: string): { hour: number; minute: number } {
  const [h, m] = at.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/** The cron fields a daily/weekly cadence is shorthand for. */
function fieldsFor(cadence: Cadence): CronFields | null {
  if (cadence.kind === 'cron') return parseCron(cadence.expr);
  if (cadence.kind === 'daily') {
    const { hour, minute } = splitAt(cadence.at);
    return {
      minutes: [minute], hours: [hour],
      daysOfMonth: allBetween(1, 31), months: allBetween(1, 12), daysOfWeek: allBetween(0, 6),
      domRestricted: false, dowRestricted: false,
    };
  }
  if (cadence.kind === 'weekly') {
    const { hour, minute } = splitAt(cadence.at);
    return {
      minutes: [minute], hours: [hour],
      daysOfMonth: allBetween(1, 31), months: allBetween(1, 12), daysOfWeek: [cadence.day],
      domRestricted: false, dowRestricted: true,
    };
  }
  return null;
}

function allBetween(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let v = lo; v <= hi; v++) out.push(v);
  return out;
}

/**
 * The first moment strictly after `after` at which this cadence fires, or
 * null when it never will (an impossible cron expression, or an unparseable
 * one that slipped past validation — a ticker must not throw).
 */
export function nextRunAt(cadence: Cadence, after: Date): Date | null {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) return null;
  if (cadence.kind === 'interval') {
    if (!Number.isInteger(cadence.everyMinutes) || cadence.everyMinutes < 1) return null;
    // Elapsed time, not wall clock: immune to DST by construction.
    return new Date(after.getTime() + cadence.everyMinutes * 60_000);
  }
  let fields: CronFields | null;
  try {
    fields = fieldsFor(cadence);
  } catch {
    return null;
  }
  return fields ? nextWallClock(after, fields) : null;
}

/** The next `count` firings after `after` — the UI's "next three runs". */
export function nextRuns(cadence: Cadence, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextRunAt(cadence, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Validates arbitrary JSON into a Cadence, or explains what is wrong. The
 * server answers 400 with `error`; a bad cron expression must never become a
 * schedule that silently never runs.
 */
export function validateCadence(input: unknown): { ok: true; cadence: Cadence } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'cadence must be an object' };
  const o = input as Record<string, unknown>;
  const kind = o.kind;

  if (kind === 'daily' || kind === 'weekly') {
    if (typeof o.at !== 'string' || !AT_RE.test(o.at)) {
      return { ok: false, error: `at must be a time of day as "HH:MM", got ${JSON.stringify(o.at)}` };
    }
    if (kind === 'daily') return { ok: true, cadence: { kind: 'daily', at: o.at } };
    if (!Number.isInteger(o.day) || (o.day as number) < 0 || (o.day as number) > 6) {
      return { ok: false, error: `day must be a whole number 0 (Sunday) to 6 (Saturday), got ${JSON.stringify(o.day)}` };
    }
    return { ok: true, cadence: { kind: 'weekly', day: o.day as number, at: o.at } };
  }

  if (kind === 'interval') {
    if (!Number.isInteger(o.everyMinutes)) {
      return { ok: false, error: `everyMinutes must be a whole number of minutes, got ${JSON.stringify(o.everyMinutes)}` };
    }
    // An hour is the floor on purpose: anything tighter is a poll loop, not a
    // schedule, and a mission takes longer than that to run anyway.
    if ((o.everyMinutes as number) < 60) return { ok: false, error: 'everyMinutes must be at least 60' };
    return { ok: true, cadence: { kind: 'interval', everyMinutes: o.everyMinutes as number } };
  }

  if (kind === 'cron') {
    if (typeof o.expr !== 'string' || !o.expr.trim()) return { ok: false, error: 'expr must be a cron expression' };
    try {
      parseCron(o.expr);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, cadence: { kind: 'cron', expr: o.expr.trim().split(/\s+/).join(' ') } };
  }

  return { ok: false, error: `kind must be daily, weekly, interval or cron, got ${JSON.stringify(kind)}` };
}

/** The cadence in words, for a run list or a confirmation line. */
export function describeCadence(cadence: Cadence): string {
  switch (cadence.kind) {
    case 'daily':
      return `daily ${cadence.at}`;
    case 'weekly':
      return `every ${DAY_NAMES[cadence.day] ?? `day ${cadence.day}`} ${cadence.at}`;
    case 'interval': {
      const m = cadence.everyMinutes;
      if (m % 60 === 0) {
        const hours = m / 60;
        return hours === 1 ? 'every hour' : `every ${hours} hours`;
      }
      return `every ${m} minutes`;
    }
    case 'cron':
      return `cron ${cadence.expr}`;
  }
}
