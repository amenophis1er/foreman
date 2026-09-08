// Scheduling is wall-clock arithmetic, so the tests have to own the clock:
// pin the zone before anything reads a Date, and skip the DST assertions on a
// machine where the pin did not take (Node re-reads process.env.TZ, but a
// container without tzdata cannot honour it).
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeCadence, nextRunAt, nextRuns, parseCron, validateCadence, type Cadence,
} from './schedule.js';

/** Is the process actually in US Eastern, offsets and all? */
const EASTERN = new Date(2026, 0, 15, 12, 0).getTimezoneOffset() === 300
  && new Date(2026, 6, 15, 12, 0).getTimezoneOffset() === 240;

/** A local-time Date, written the way the assertions read. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0);

/** 'YYYY-MM-DD HH:MM' in local time — what a failure message should show. */
const show = (d: Date | null) => (d === null ? 'null' : [
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
].join(' '));

const at = (cadence: Cadence, after: Date) => show(nextRunAt(cadence, after));

test('daily fires at its wall-clock time, and rolls to tomorrow once past', () => {
  const daily: Cadence = { kind: 'daily', at: '07:30' };
  assert.equal(at(daily, local(2026, 3, 2, 6, 0)), '2026-03-02 07:30');
  assert.equal(at(daily, local(2026, 3, 2, 7, 29, 59)), '2026-03-02 07:30');
  // Strictly after: standing exactly on the firing minute means tomorrow.
  assert.equal(at(daily, local(2026, 3, 2, 7, 30)), '2026-03-03 07:30');
  assert.equal(at(daily, local(2026, 3, 2, 8, 0)), '2026-03-03 07:30');
  // Seconds and milliseconds are never carried into a firing.
  const next = nextRunAt(daily, local(2026, 3, 2, 6, 0, 42))!;
  assert.equal(next.getSeconds(), 0);
  assert.equal(next.getMilliseconds(), 0);
  // Month and year roll on their own.
  assert.equal(at(daily, local(2026, 12, 31, 9, 0)), '2027-01-01 07:30');
});

test('weekly fires on its day, rolling a whole week when the day has passed', () => {
  const monday: Cadence = { kind: 'weekly', day: 1, at: '09:00' };
  // 2026-03-04 is a Wednesday.
  assert.equal(local(2026, 3, 4).getDay(), 3);
  assert.equal(at(monday, local(2026, 3, 4, 12, 0)), '2026-03-09 09:00');
  // On the day, before and after the hour.
  assert.equal(at(monday, local(2026, 3, 9, 8, 59)), '2026-03-09 09:00');
  assert.equal(at(monday, local(2026, 3, 9, 9, 0)), '2026-03-16 09:00');
  // Sunday is 0, not 7.
  assert.equal(at({ kind: 'weekly', day: 0, at: '23:00' }, local(2026, 3, 4, 12, 0)), '2026-03-08 23:00');
});

test('interval is elapsed time from `after`, to the millisecond', () => {
  const six: Cadence = { kind: 'interval', everyMinutes: 360 };
  const from = local(2026, 5, 4, 10, 17, 33);
  assert.equal(nextRunAt(six, from)!.getTime() - from.getTime(), 360 * 60_000);
  const ninety = nextRunAt({ kind: 'interval', everyMinutes: 90 }, from)!;
  assert.equal(ninety.getTime() - from.getTime(), 90 * 60_000);
});

test('cron: single values, lists, ranges and steps', () => {
  assert.equal(at({ kind: 'cron', expr: '0 9 * * *' }, local(2026, 3, 2, 12, 0)), '2026-03-03 09:00');
  // A list of minutes inside the hour.
  const list: Cadence = { kind: 'cron', expr: '1,15,45 * * * *' };
  assert.equal(at(list, local(2026, 3, 2, 12, 2)), '2026-03-02 12:15');
  assert.equal(at(list, local(2026, 3, 2, 12, 45)), '2026-03-02 13:01');
  // A range of weekdays: Friday 09:00 jumps to Monday.
  const weekdays: Cadence = { kind: 'cron', expr: '0 9 * * 1-5' };
  assert.equal(local(2026, 3, 6).getDay(), 5);
  assert.equal(at(weekdays, local(2026, 3, 6, 9, 0)), '2026-03-09 09:00');
  // Steps, on the minute field and on a range.
  assert.equal(at({ kind: 'cron', expr: '*/15 * * * *' }, local(2026, 3, 2, 12, 1)), '2026-03-02 12:15');
  assert.equal(at({ kind: 'cron', expr: '10-50/20 * * * *' }, local(2026, 3, 2, 12, 31)), '2026-03-02 12:50');
  assert.equal(at({ kind: 'cron', expr: '10-50/20 * * * *' }, local(2026, 3, 2, 12, 51)), '2026-03-02 13:10');
  // An hour step lands on the next multiple, not the next hour.
  assert.equal(at({ kind: 'cron', expr: '0 */6 * * *' }, local(2026, 3, 2, 7, 0)), '2026-03-02 12:00');
});

test('parseCron: fields come back sorted, and 7 means Sunday', () => {
  const c = parseCron('45,15 1-3 1,15 */6 7');
  assert.deepEqual(c.minutes, [15, 45]);
  assert.deepEqual(c.hours, [1, 2, 3]);
  assert.deepEqual(c.daysOfMonth, [1, 15]);
  assert.deepEqual(c.months, [1, 7]);
  assert.deepEqual(c.daysOfWeek, [0]);
  assert.equal(c.domRestricted, true);
  assert.equal(c.dowRestricted, true);
  const star = parseCron('0 0 * * *');
  assert.equal(star.domRestricted, false);
  assert.equal(star.dowRestricted, false);
  assert.equal(star.daysOfMonth.length, 31);
  assert.equal(star.daysOfWeek.length, 7);
  // Extra whitespace between fields is not an error.
  assert.deepEqual(parseCron('  0   9  *  *  1  ').hours, [9]);
});

test('cron: with both day fields restricted, either one may match', () => {
  // "the 1st of the month, and every Monday" — not the intersection.
  const both: Cadence = { kind: 'cron', expr: '0 0 1 * 1' };
  // 2026-04-01 is a Wednesday; it fires on the date alone.
  assert.equal(local(2026, 4, 1).getDay(), 3);
  assert.equal(at(both, local(2026, 3, 31, 12, 0)), '2026-04-01 00:00');
  // and on the next Monday, which is not the 1st.
  assert.equal(at(both, local(2026, 4, 1, 0, 0)), '2026-04-06 00:00');
  assert.equal(local(2026, 4, 6).getDay(), 1);
  // One field restricted is a plain AND with the other's "every".
  assert.equal(at({ kind: 'cron', expr: '0 0 1 * *' }, local(2026, 4, 1, 0, 0)), '2026-05-01 00:00');
});

test('cron: month ends, February, and a leap day', () => {
  // The 31st skips the 30-day months entirely: Jan 31 → Mar 31.
  assert.equal(at({ kind: 'cron', expr: '0 0 31 * *' }, local(2026, 1, 31, 0, 0)), '2026-03-31 00:00');
  assert.equal(at({ kind: 'cron', expr: '0 0 31 * *' }, local(2026, 4, 1, 0, 0)), '2026-05-31 00:00');
  // A February end-of-month rule lands on the 28th in a common year...
  assert.equal(at({ kind: 'cron', expr: '0 12 28-31 2 *' }, local(2026, 2, 27, 0, 0)), '2026-02-28 12:00');
  assert.equal(at({ kind: 'cron', expr: '0 12 28-31 2 *' }, local(2026, 2, 28, 12, 0)), '2027-02-28 12:00');
  // ...and on the 29th in a leap year. 2028 is one; 2100 would not be.
  assert.equal(at({ kind: 'cron', expr: '0 12 29 2 *' }, local(2026, 1, 1, 0, 0)), '2028-02-29 12:00');
  // February 30th never happens; the scan gives up instead of hanging.
  assert.equal(nextRunAt({ kind: 'cron', expr: '0 0 30 2 *' }, local(2026, 1, 1, 0, 0)), null);
});

test('interval survives a DST change; wall-clock cadences keep the clock time', { skip: EASTERN ? false : 'not in America/New_York' }, () => {
  // 2026-03-08 is spring forward in US Eastern: 02:00 becomes 03:00.
  assert.equal(new Date(2026, 2, 8, 0, 30).getTimezoneOffset(), 300);
  assert.equal(new Date(2026, 2, 8, 12, 0).getTimezoneOffset(), 240);

  // Six hours means six hours: 00:30 EST + 6 h reads 07:30 EDT on the wall.
  const from = local(2026, 3, 8, 0, 30);
  const six = nextRunAt({ kind: 'interval', everyMinutes: 360 }, from)!;
  assert.equal(six.getTime() - from.getTime(), 6 * 3_600_000);
  assert.equal(show(six), '2026-03-08 07:30');

  // 02:30 does not exist that morning. It must still resolve to a real
  // instant just after the skip, not hang and not vanish.
  const daily: Cadence = { kind: 'daily', at: '02:30' };
  const skipped = nextRunAt(daily, local(2026, 3, 7, 12, 0))!;
  assert.ok(skipped.getTime() > local(2026, 3, 7, 12, 0).getTime());
  assert.equal(show(skipped), '2026-03-08 03:30');
  // and the day after is an ordinary 02:30 again.
  assert.equal(show(nextRunAt(daily, skipped)), '2026-03-09 02:30');

  // Fall back (2026-11-01, 02:00 becomes 01:00): the hour repeats, and a
  // daily 01:30 fires once, then the next day.
  const back = nextRunAt({ kind: 'daily', at: '01:30' }, local(2026, 11, 1, 0, 0))!;
  assert.equal(show(back), '2026-11-01 01:30');
  assert.equal(show(nextRunAt({ kind: 'daily', at: '01:30' }, back)), '2026-11-02 01:30');

  // A whole DST week of firings stays strictly increasing.
  const week = nextRuns({ kind: 'daily', at: '02:30' }, local(2026, 3, 6, 12, 0), 5);
  assert.equal(week.length, 5);
  for (let i = 1; i < week.length; i++) assert.ok(week[i].getTime() > week[i - 1].getTime());
});

test('parseCron: bad expressions say which field and why', () => {
  const why = (expr: string) => {
    try {
      parseCron(expr);
    } catch (e) {
      return (e as Error).message;
    }
    assert.fail(`expected ${JSON.stringify(expr)} to be rejected`);
  };
  assert.match(why('62 * * * *'), /minute: "62" is out of range 0-59/);
  assert.match(why('0 24 * * *'), /hour: "24" is out of range 0-23/);
  assert.match(why('0 0 0 * *'), /day-of-month: "0" is out of range 1-31/);
  assert.match(why('0 0 * 13 *'), /month: "13" is out of range 1-12/);
  assert.match(why('0 0 * * 8'), /day-of-week: "8" is out of range 0-7/);
  assert.match(why('0 0 * * mon'), /day-of-week: "mon" is out of range/);
  assert.match(why('0 0 * *'), /five fields.*got 4/);
  assert.match(why('0 0 * * * *'), /five fields.*got 6/);
  assert.match(why(''), /five fields.*got 0/);
  assert.match(why('5-1 * * * *'), /minute: range "5-1" runs backwards/);
  assert.match(why('*/0 * * * *'), /minute: step "0" must be a whole number of 1 or more/);
  assert.match(why('0,,5 * * * *'), /minute: .* has an empty item/);
  assert.match(why('1-2-3 * * * *'), /minute: "1-2-3" is not a range/);
  assert.match(why('*/2/2 * * * *'), /minute: .* has more than one step/);
});

test('validateCadence: accepts what it should and explains what it will not', () => {
  assert.deepEqual(validateCadence({ kind: 'daily', at: '07:30' }), { ok: true, cadence: { kind: 'daily', at: '07:30' } });
  assert.deepEqual(validateCadence({ kind: 'weekly', day: 6, at: '23:59' }), { ok: true, cadence: { kind: 'weekly', day: 6, at: '23:59' } });
  assert.deepEqual(validateCadence({ kind: 'interval', everyMinutes: 60 }), { ok: true, cadence: { kind: 'interval', everyMinutes: 60 } });
  // Extra fields are dropped, and a cron expression comes back normalised.
  assert.deepEqual(validateCadence({ kind: 'cron', expr: ' 0  9 * * 1-5 ', junk: 1 }), { ok: true, cadence: { kind: 'cron', expr: '0 9 * * 1-5' } });

  const bad = (input: unknown) => {
    const r = validateCadence(input);
    assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
    return (r as { ok: false; error: string }).error;
  };
  assert.match(bad(null), /must be an object/);
  assert.match(bad('daily'), /must be an object/);
  assert.match(bad([{ kind: 'daily', at: '07:30' }]), /must be an object/);
  assert.match(bad({ kind: 'hourly' }), /kind must be daily, weekly, interval or cron/);
  assert.match(bad({ kind: 'daily' }), /"HH:MM"/);
  assert.match(bad({ kind: 'daily', at: '7:30' }), /"HH:MM"/);
  assert.match(bad({ kind: 'daily', at: '24:00' }), /"HH:MM"/);
  assert.match(bad({ kind: 'daily', at: '07:60' }), /"HH:MM"/);
  assert.match(bad({ kind: 'weekly', day: 7, at: '07:30' }), /day must be a whole number 0/);
  assert.match(bad({ kind: 'weekly', day: 1.5, at: '07:30' }), /day must be a whole number 0/);
  assert.match(bad({ kind: 'weekly', at: '07:30' }), /day must be a whole number 0/);
  assert.match(bad({ kind: 'interval', everyMinutes: 59 }), /at least 60/);
  assert.match(bad({ kind: 'interval', everyMinutes: 90.5 }), /whole number of minutes/);
  assert.match(bad({ kind: 'interval', everyMinutes: '90' }), /whole number of minutes/);
  // The point of validating cron here: the reason travels to the 400.
  assert.match(bad({ kind: 'cron', expr: '99 * * * *' }), /minute: "99" is out of range 0-59/);
  assert.match(bad({ kind: 'cron', expr: '   ' }), /expr must be a cron expression/);
  assert.match(bad({ kind: 'cron' }), /expr must be a cron expression/);
});

test('nextRuns previews N firings, strictly increasing', () => {
  const three = nextRuns({ kind: 'daily', at: '07:30' }, local(2026, 5, 4, 9, 0), 3);
  assert.deepEqual(three.map(show), ['2026-05-05 07:30', '2026-05-06 07:30', '2026-05-07 07:30']);
  for (let i = 1; i < three.length; i++) assert.ok(three[i].getTime() > three[i - 1].getTime());

  assert.deepEqual(
    nextRuns({ kind: 'interval', everyMinutes: 90 }, local(2026, 5, 4, 9, 0), 3).map(show),
    ['2026-05-04 10:30', '2026-05-04 12:00', '2026-05-04 13:30'],
  );
  assert.deepEqual(
    nextRuns({ kind: 'cron', expr: '0 9 * * 1-5' }, local(2026, 3, 6, 12, 0), 3).map(show),
    ['2026-03-09 09:00', '2026-03-10 09:00', '2026-03-11 09:00'],
  );
  // Nothing to preview: an impossible expression, and a zero count.
  assert.deepEqual(nextRuns({ kind: 'cron', expr: '0 0 30 2 *' }, local(2026, 1, 1), 3), []);
  assert.deepEqual(nextRuns({ kind: 'daily', at: '07:30' }, local(2026, 1, 1), 0), []);
});

test('describeCadence puts the cadence in words', () => {
  assert.equal(describeCadence({ kind: 'daily', at: '07:30' }), 'daily 07:30');
  assert.equal(describeCadence({ kind: 'weekly', day: 1, at: '09:00' }), 'every Monday 09:00');
  assert.equal(describeCadence({ kind: 'weekly', day: 0, at: '18:15' }), 'every Sunday 18:15');
  assert.equal(describeCadence({ kind: 'interval', everyMinutes: 360 }), 'every 6 hours');
  assert.equal(describeCadence({ kind: 'interval', everyMinutes: 60 }), 'every hour');
  assert.equal(describeCadence({ kind: 'interval', everyMinutes: 90 }), 'every 90 minutes');
  assert.equal(describeCadence({ kind: 'cron', expr: '0 9 * * 1-5' }), 'cron 0 9 * * 1-5');
});
