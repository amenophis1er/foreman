import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PRESETS,
  REVIEWER_TOOL_POLICY,
  normalizePresets,
  crewPresetsFrom,
  freezeCrew,
  parseVerdict,
  diffHash,
  reviewBlockers,
  unreviewedText,
  reviewBriefFor,
  type CrewPreset,
  type ReviewVerdict,
} from './crew.js';

/** A preset with only the fields a given test cares about spelled out. */
function preset(over: Partial<CrewPreset> = {}): CrewPreset {
  return { id: 'reviewer', name: 'Reviewer', kind: 'reviewer', brief: 'look hard', requiredForDone: true, ...over };
}

/** A verdict about diff 'h1' unless told otherwise. */
function verdict(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    presetId: 'reviewer', name: 'Reviewer', pass: true, findings: '',
    diffHash: 'h1', workerId: 'w1', at: 1000, ...over,
  };
}

/** A deck file. */
function file(over: Partial<{ path: string; status: string; additions: number; deletions: number; diff: string }> = {}) {
  return { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, diff: '@@ -1 +1 @@\n-a\n+b', ...over };
}

test('BUILT_IN_PRESETS: two reviewers, only the first one gates', () => {
  assert.deepEqual(BUILT_IN_PRESETS.map((p) => p.id), ['reviewer', 'security-review']);
  assert.deepEqual(BUILT_IN_PRESETS.map((p) => p.requiredForDone), [true, false]);
  for (const p of BUILT_IN_PRESETS) {
    assert.equal(p.kind, 'reviewer');
    assert.equal(p.model, 'opus');
    assert.equal(p.toolPolicy, 'read-only');
    assert.ok(p.brief.length > 40, `${p.id} needs a real brief`);
  }
  // Shared by every project on the server, so nobody gets to edit them in place.
  assert.ok(Object.isFrozen(BUILT_IN_PRESETS));
  assert.throws(() => { (BUILT_IN_PRESETS[0] as CrewPreset).requiredForDone = false; });
});

test('REVIEWER_TOOL_POLICY: the four writing tools, denied flat', () => {
  assert.deepEqual({ ...REVIEWER_TOOL_POLICY }, {
    Write: 'deny', Edit: 'deny', NotebookEdit: 'deny', Bash: 'deny',
  });
});

test('parseVerdict: PASS and FAIL, with everything after the line as findings', () => {
  assert.deepEqual(parseVerdict('VERDICT: PASS'), { pass: true, findings: '' });
  assert.deepEqual(parseVerdict('looked at it\nVERDICT: FAIL\n\nsrc/a.ts:12 no test\n'), {
    pass: false, findings: 'src/a.ts:12 no test',
  });
  // Surrounding whitespace on the line itself is tolerated.
  assert.deepEqual(parseVerdict('   VERDICT:   PASS   \nfine'), { pass: true, findings: 'fine' });
});

test('parseVerdict: lowercase and markdown decoration still count', () => {
  assert.deepEqual(parseVerdict('verdict: pass'), { pass: true, findings: '' });
  assert.deepEqual(parseVerdict('**VERDICT: FAIL**\nbad'), { pass: false, findings: 'bad' });
  assert.deepEqual(parseVerdict('## VERDICT: PASS'), { pass: true, findings: '' });
  assert.deepEqual(parseVerdict('### **verdict: Fail**'), { pass: false, findings: '' });
});

test('parseVerdict: no verdict is null, not FAIL', () => {
  // The caller has to tell "the reviewer said no" from "the reviewer never
  // answered" — they are different problems with different fixes.
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict('I ran out of turns before I could finish.'), null);
  // Malformed is malformed: a word that is neither, and a verdict with nothing
  // after the colon.
  assert.equal(parseVerdict('VERDICT: MAYBE'), null);
  assert.equal(parseVerdict('VERDICT:'), null);
  assert.equal(parseVerdict('VERDICT: PASS with reservations'), null);
  // Mentioned mid-sentence rather than on its own line.
  assert.equal(parseVerdict('my VERDICT: PASS on this one'), null);
});

test('parseVerdict: the last verdict line wins', () => {
  const report = [
    'I will end with VERDICT: PASS or VERDICT: FAIL as instructed.',
    'Now the review.',
    'VERDICT: FAIL',
    'src/a.ts:3 off by one',
  ].join('\n');
  // The first two are inside a sentence, so they are not lines; the real one is.
  assert.deepEqual(parseVerdict(report), { pass: false, findings: 'src/a.ts:3 off by one' });

  // Two genuine verdict lines: the model changed its mind, and the one it
  // ended on is the one it means.
  assert.deepEqual(parseVerdict('VERDICT: PASS\nthen I looked again\nVERDICT: FAIL\nsrc/b.ts:9'), {
    pass: false, findings: 'src/b.ts:9',
  });
});

test('parseVerdict: a runaway report is cut and says so', () => {
  const parsed = parseVerdict('VERDICT: FAIL\n' + 'x'.repeat(20000));
  assert.ok(parsed);
  assert.equal(parsed.pass, false);
  assert.ok(parsed.findings.length < 8200, 'findings should be capped');
  assert.match(parsed.findings, /truncated/);
  // Just under the cap is kept whole.
  const short = parseVerdict('VERDICT: PASS\n' + 'y'.repeat(100));
  assert.equal(short?.findings, 'y'.repeat(100));
});

test('diffHash: deterministic, order-independent, and empty is legal', () => {
  const a = file({ path: 'src/a.ts' });
  const b = file({ path: 'src/b.ts', status: 'added', additions: 9, deletions: 0, diff: '+new' });
  assert.equal(diffHash({ files: [a, b] }), diffHash({ files: [a, b] }));
  // Same files, different order: the same run, so the same hash.
  assert.equal(diffHash({ files: [a, b] }), diffHash({ files: [b, a] }));
  assert.match(diffHash({ files: [a] }), /^[0-9a-f]{64}$/);

  // No changes at all is a stable hash, not a crash.
  assert.equal(diffHash({}), diffHash({ files: [] }));
  assert.match(diffHash({}), /^[0-9a-f]{64}$/);
  assert.notEqual(diffHash({}), diffHash({ files: [a] }));
});

test('diffHash: any change to a file moves the hash', () => {
  const base = diffHash({ files: [file()] });
  assert.notEqual(base, diffHash({ files: [file({ diff: '@@ -1 +1 @@\n-a\n+c' })] }));
  assert.notEqual(base, diffHash({ files: [file({ path: 'src/z.ts' })] }));
  assert.notEqual(base, diffHash({ files: [file({ status: 'deleted' })] }));
  assert.notEqual(base, diffHash({ files: [file({ additions: 4 })] }));
  assert.notEqual(base, diffHash({ files: [file({ deletions: 2 })] }));
  // A missing diff body hashes as empty, and is not the same as any body.
  const nodiff = { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1 };
  assert.equal(diffHash({ files: [nodiff] }), diffHash({ files: [{ ...nodiff, diff: '' }] }));
  assert.notEqual(diffHash({ files: [nodiff] }), base);
});

test('normalizePresets: null when it is not an array, [] when the human emptied it', () => {
  // The whole reason this returns null: "nothing configured" and "nothing
  // wanted" must not be the same answer.
  for (const junk of [undefined, null, {}, 'reviewer', 7, true]) {
    assert.equal(normalizePresets(junk), null);
  }
  assert.deepEqual(normalizePresets([]), []);
});

test('normalizePresets: junk entries are dropped, not repaired', () => {
  const got = normalizePresets([
    null, 7, 'reviewer', [], {},
    { id: 'no-name' },
    { name: 'no id' },
    { id: '   ', name: 'blank id' },
    { id: 'blank-name', name: '  ' },
    { id: 'ok', name: 'Ok' },
  ]);
  assert.deepEqual(got?.map((p) => p.id), ['ok']);
});

test('normalizePresets: defaults filled, optionals only when they are real', () => {
  const [p] = normalizePresets([{ id: 'a', name: 'A' }])!;
  assert.deepEqual(p, { id: 'a', name: 'A', kind: 'reviewer', brief: '', requiredForDone: false });

  const [q] = normalizePresets([{
    id: 'b', name: 'B', kind: 'specialist', brief: 'do the thing',
    model: 'sonnet', providerId: 'prov1', toolPolicy: 'default', requiredForDone: true,
  }])!;
  assert.deepEqual(q, {
    id: 'b', name: 'B', kind: 'specialist', brief: 'do the thing',
    model: 'sonnet', providerId: 'prov1', toolPolicy: 'default', requiredForDone: true,
  });

  // Unknown kind falls back to reviewer; empty strings are not values;
  // anything short of a literal true is not consent to block a run.
  const [r] = normalizePresets([{
    id: 'c', name: 'C', kind: 'wizard', brief: 42,
    model: '', providerId: '  ', toolPolicy: 'yolo', requiredForDone: 'yes',
  }])!;
  assert.deepEqual(r, { id: 'c', name: 'C', kind: 'reviewer', brief: '', requiredForDone: false });
  assert.equal(normalizePresets([{ id: 'd', name: 'D', requiredForDone: 1 }])![0].requiredForDone, false);
});

test('normalizePresets: duplicate ids, first wins', () => {
  const got = normalizePresets([
    { id: 'r', name: 'First', requiredForDone: true },
    { id: 'r', name: 'Second' },
    { id: 's', name: 'Other' },
  ])!;
  assert.deepEqual(got.map((p) => [p.id, p.name]), [['r', 'First'], ['s', 'Other']]);
  assert.equal(got[0].requiredForDone, true);
});

test('crewPresetsFrom: built-ins, then global, then the project', () => {
  assert.deepEqual(crewPresetsFrom(undefined, undefined).map((p) => p.id), ['reviewer', 'security-review']);
  assert.deepEqual(crewPresetsFrom({}, {}).map((p) => p.id), ['reviewer', 'security-review']);

  const global = { crewPresets: [{ id: 'g', name: 'G' }, { id: 'h', name: 'H' }] };
  assert.deepEqual(crewPresetsFrom(global, undefined).map((p) => p.id), ['g', 'h']);
  assert.deepEqual(crewPresetsFrom(global, {}).map((p) => p.id), ['g', 'h']);

  // The project's list REPLACES the global one — it does not merge, or 'g'
  // would still be here and "I removed the reviewer on this project" would be
  // unsayable.
  const project = { crewPresets: [{ id: 'p', name: 'P' }] };
  assert.deepEqual(crewPresetsFrom(global, project).map((p) => p.id), ['p']);
  // Including down to nothing.
  assert.deepEqual(crewPresetsFrom(global, { crewPresets: [] }), []);
  assert.deepEqual(crewPresetsFrom({ crewPresets: [] }, undefined), []);
  // A project blob with junk in crewPresets is "not configured", so the global
  // list still speaks.
  assert.deepEqual(crewPresetsFrom(global, { crewPresets: 'reviewer' }).map((p) => p.id), ['g', 'h']);
});

test('crewPresetsFrom: hands out copies of the built-ins', () => {
  const crew = crewPresetsFrom(undefined, undefined);
  crew[0].requiredForDone = false;
  crew[0].name = 'Tampered';
  assert.equal(BUILT_IN_PRESETS[0].requiredForDone, true);
  assert.equal(BUILT_IN_PRESETS[0].name, 'Reviewer');
  assert.equal(crewPresetsFrom(undefined, undefined)[0].requiredForDone, true);
});

test('freezeCrew: presets order, deduped, unknown ids ignored', () => {
  const presets = [preset({ id: 'a', name: 'A' }), preset({ id: 'b', name: 'B' }), preset({ id: 'c', name: 'C' })];
  // The order of `presets` decides, not the order of `ids`.
  assert.deepEqual(freezeCrew(['c', 'a'], presets).map((p) => p.id), ['a', 'c']);
  assert.deepEqual(freezeCrew(['a', 'a', 'b'], presets).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(freezeCrew(['nope'], presets), []);
  assert.deepEqual(freezeCrew([], presets), []);
  assert.deepEqual(freezeCrew(['a', 'ghost'], presets).map((p) => p.id), ['a']);
});

test('freezeCrew: the run keeps a copy, so a later edit cannot rewrite its gate', () => {
  const source = preset({ id: 'a', name: 'A', model: 'opus', providerId: 'prov', toolPolicy: 'read-only' });
  const [frozen] = freezeCrew(['a'], [source]);
  assert.deepEqual(frozen, source);
  assert.notEqual(frozen, source);
  frozen.requiredForDone = false;
  frozen.brief = 'do nothing';
  frozen.name = 'Tampered';
  assert.equal(source.requiredForDone, true);
  assert.equal(source.brief, 'look hard');
  assert.equal(source.name, 'A');
  // And the other way: editing the preset afterwards does not reach the run.
  source.model = 'haiku';
  assert.equal(frozen.model, 'opus');
});

test('reviewBlockers: nothing required means nothing blocks', () => {
  assert.deepEqual(reviewBlockers(undefined, undefined, 'h1'), []);
  assert.deepEqual(reviewBlockers([], [], 'h1'), []);
  // A reviewer the human did not mark as required never blocks, however badly
  // it went.
  const optional = [preset({ id: 'sec', name: 'Security review', requiredForDone: false })];
  assert.deepEqual(reviewBlockers(optional, [], 'h1'), []);
  assert.deepEqual(reviewBlockers(optional, [verdict({ presetId: 'sec', pass: false })], 'h1'), []);
});

test('reviewBlockers: missing, fail, stale, pass', () => {
  const crew = [preset()];
  assert.deepEqual(reviewBlockers(crew, [], 'h1'), [{ presetId: 'reviewer', name: 'Reviewer', reason: 'missing' }]);
  // Someone else's verdict is not this reviewer's verdict.
  assert.deepEqual(reviewBlockers(crew, [verdict({ presetId: 'other' })], 'h1'), [
    { presetId: 'reviewer', name: 'Reviewer', reason: 'missing' },
  ]);
  assert.deepEqual(reviewBlockers(crew, [verdict({ pass: false })], 'h1'), [
    { presetId: 'reviewer', name: 'Reviewer', reason: 'fail' },
  ]);
  // Passed, then the code moved: that PASS was about a diff that no longer
  // exists.
  assert.deepEqual(reviewBlockers(crew, [verdict({ diffHash: 'h0' })], 'h1'), [
    { presetId: 'reviewer', name: 'Reviewer', reason: 'stale' },
  ]);
  assert.deepEqual(reviewBlockers(crew, [verdict()], 'h1'), []);
});

test('reviewBlockers: the latest verdict decides', () => {
  const crew = [preset()];
  // A later FAIL overrules an earlier PASS, whatever order they are stored in.
  const passThenFail = [verdict({ at: 1 }), verdict({ at: 2, pass: false })];
  assert.deepEqual(reviewBlockers(crew, passThenFail, 'h1').map((b) => b.reason), ['fail']);
  assert.deepEqual(reviewBlockers(crew, [...passThenFail].reverse(), 'h1').map((b) => b.reason), ['fail']);
  // And a re-review clears an earlier FAIL.
  assert.deepEqual(reviewBlockers(crew, [verdict({ at: 1, pass: false }), verdict({ at: 2 })], 'h1'), []);
  // Same millisecond: the one appended later is the later one.
  assert.deepEqual(
    reviewBlockers(crew, [verdict({ at: 5, pass: false }), verdict({ at: 5 })], 'h1'),
    [],
  );
  assert.deepEqual(
    reviewBlockers(crew, [verdict({ at: 5 }), verdict({ at: 5, pass: false })], 'h1').map((b) => b.reason),
    ['fail'],
  );
});

test('reviewBlockers: several reviewers, in crew order', () => {
  const crew = [
    preset({ id: 'a', name: 'A' }),
    preset({ id: 'sec', name: 'Security review', requiredForDone: false }),
    preset({ id: 'b', name: 'B' }),
    preset({ id: 'c', name: 'C' }),
  ];
  const verdicts = [
    verdict({ presetId: 'c', name: 'C' }),               // passed the current diff
    verdict({ presetId: 'b', name: 'B', pass: false }),  // said no
    verdict({ presetId: 'sec', pass: false }),           // not required, so silent
    // 'a' never answered.
  ];
  assert.deepEqual(reviewBlockers(crew, verdicts, 'h1'), [
    { presetId: 'a', name: 'A', reason: 'missing' },
    { presetId: 'b', name: 'B', reason: 'fail' },
  ]);
  // Move the diff and the one that had passed goes stale too.
  assert.deepEqual(reviewBlockers(crew, verdicts, 'h2').map((b) => [b.presetId, b.reason]), [
    ['a', 'missing'], ['b', 'fail'], ['c', 'stale'],
  ]);
});

test('unreviewedText: one reviewer, named, with what is wrong with it', () => {
  assert.equal(unreviewedText([]), '');
  const one = unreviewedText([{ presetId: 'reviewer', name: 'Reviewer', reason: 'missing' }]);
  assert.match(one, /^A required reviewer has not passed this run: Reviewer has not reviewed this run\./);
  assert.match(one, /not done\. Resume to continue it\.$/);
  assert.match(unreviewedText([{ presetId: 'r', name: 'Reviewer', reason: 'fail' }]), /Reviewer returned FAIL/);
  assert.match(
    unreviewedText([{ presetId: 'r', name: 'Reviewer', reason: 'stale' }]),
    /Reviewer passed an earlier version of the diff; the code changed after it/,
  );
});

test('unreviewedText: several reviewers, plural and joined', () => {
  const text = unreviewedText([
    { presetId: 'a', name: 'Reviewer', reason: 'missing' },
    { presetId: 'b', name: 'Security review', reason: 'fail' },
    { presetId: 'c', name: 'Perf', reason: 'stale' },
  ]);
  assert.match(text, /^Required reviewers have not passed this run:/);
  assert.match(text, /Reviewer has not reviewed this run; Security review returned FAIL; and Perf passed an earlier version/);
  assert.match(text, /This run is not done\. Resume to continue it\.$/);
  // Singular and plural are the only difference in the lead.
  assert.ok(!/Required reviewers/.test(unreviewedText([{ presetId: 'a', name: 'A', reason: 'fail' }])));
});

test('reviewBriefFor: carries the brief, the mission, the criteria, the diff and the format', () => {
  const brief = reviewBriefFor(preset({ brief: 'Be demanding.' }), {
    mission: 'Add crew presets',
    doneWhen: '- [x] tests pass',
    diff: '@@ -1 +1 @@\n+ok',
    truncated: false,
  });
  assert.match(brief, /Be demanding\./);
  assert.match(brief, /Add crew presets/);
  assert.match(brief, /- \[x\] tests pass/);
  assert.match(brief, /```diff\n@@ -1 \+1 @@\n\+ok\n```/);
  assert.match(brief, /VERDICT: PASS/);
  assert.match(brief, /VERDICT: FAIL/);
  assert.match(brief, /file:line/);
  // It is told plainly that it cannot write, so it does not burn the run
  // discovering the denials one tool call at a time.
  assert.match(brief, /cannot modify files/);
  // Nothing about reading files directly, because it was given the whole diff.
  assert.ok(!/cut short/.test(brief));
});

test('reviewBriefFor: a cut diff says so and points at the files', () => {
  const brief = reviewBriefFor(preset(), { mission: 'm', doneWhen: 'd', diff: 'x', truncated: true });
  assert.match(brief, /cut short/);
  assert.match(brief, /Read, Glob and Grep/);
  // An empty mission or criteria section is labelled rather than left blank,
  // so the reviewer is not left guessing whether it was dropped.
  const bare = reviewBriefFor(preset(), { mission: '', doneWhen: '  ', diff: '', truncated: false });
  assert.match(bare, /no brief was recorded/);
  assert.match(bare, /no criteria were recorded/);
});
