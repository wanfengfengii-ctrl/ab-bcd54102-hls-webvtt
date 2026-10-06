import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest } from '../src/normalize.mjs';
import { NormalizeError } from '../src/errors.mjs';

const M = 2 ** 33;

function segment(sequence, mpegts, { local = '00:00:00.000', cues = [] } = {}) {
  const body = cues
    .map((c) => `${c.start} --> ${c.end}\n${c.text}`)
    .join('\n\n');
  const text = `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:${local}\n\n${body}\n`;
  return { sequence, text };
}

const cue = (start, end, text) => ({ start, end, text });

test('single segment maps cues relative to firstSegmentAnchor', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: 900000,
    maxAnchorInterval: 9_000_000,
    segments: [
      segment(0, 900000, {
        cues: [
          cue('00:00:00.000', '00:00:02.000', 'A'),
          cue('00:00:03.000', '00:00:04.000', 'B')
        ]
      })
    ]
  });
  assert.deepEqual(result.cues, [
    { startTicks: 900000, endTicks: 1_080_000, text: 'A' },
    { startTicks: 1_170_000, endTicks: 1_260_000, text: 'B' }
  ]);
});

test('LOCAL offset shifts every cue', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: 1_000_000,
    maxAnchorInterval: 9_000_000,
    segments: [
      segment(0, 1_000_000, {
        local: '00:00:05.000',
        cues: [cue('00:00:05.000', '00:00:06.000', 'A')]
      })
    ]
  });
  // anchor - LOCAL(450000) + cue start(450000) = anchor
  assert.deepEqual(result.cues, [{ startTicks: 1_000_000, endTicks: 1_090_000, text: 'A' }]);
});

test('multiple segments without wrap follow raw MPEGTS', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: 0,
    maxAnchorInterval: 9_000_000,
    segments: [
      segment(0, 0, { cues: [cue('00:00:01.000', '00:00:02.000', 's0')] }),
      segment(1, 900_000, { cues: [cue('00:00:00.000', '00:00:01.000', 's1')] })
    ]
  });
  assert.deepEqual(result.cues, [
    { startTicks: 90_000, endTicks: 180_000, text: 's0' },
    { startTicks: 900_000, endTicks: 990_000, text: 's1' }
  ]);
});

test('33-bit wrap is unwrapped uniquely across the boundary', () => {
  // Segment 0 sits just below the modulus; segment 1's raw counter
  // wrapped around to a small value.
  const nearEnd = M - 450_000;
  const result = normalizeRequest({
    firstSegmentAnchor: nearEnd,
    maxAnchorInterval: 10_000_000,
    segments: [
      segment(10, nearEnd, { cues: [cue('00:00:04.000', '00:00:05.000', 'before-wrap')] }),
      segment(11, 100_000, { cues: [cue('00:00:00.000', '00:00:02.000', 'after-wrap')] })
    ]
  });
  const expectedAnchor1 = nearEnd + (M - nearEnd + 100_000); // = M + 100000
  assert.equal(expectedAnchor1, M + 100_000);
  assert.deepEqual(result.cues, [
    { startTicks: nearEnd + 360_000, endTicks: nearEnd + 450_000, text: 'before-wrap' },
    { startTicks: M + 100_000, endTicks: M + 280_000, text: 'after-wrap' }
  ]);
  // Continuity across the boundary: cues remain ordered even though raw
  // segment 1's local times are smaller than segment 0's.
  assert.ok(result.cues[0].startTicks < result.cues[1].startTicks);
});

test('first anchor with a whole-modulus offset is accepted if congruent', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: M + 12345,
    maxAnchorInterval: 9_000_000,
    segments: [segment(0, 12345, { cues: [cue('00:00:00.000', '00:00:01.000', 'A')] })]
  });
  assert.equal(result.cues[0].startTicks, M + 12345);
});

test('anchor incompatible with first segment MPEGTS is rejected', () => {
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 999,
        maxAnchorInterval: 9_000_000,
        segments: [segment(0, 1000, { cues: [] })]
      }),
    (err) => err instanceof NormalizeError && err.code === 'ANCHOR_INCOMPATIBLE' && err.segment === 0
  );
});

test('gap larger than maxAnchorInterval is ANCHOR_INCOMPATIBLE', () => {
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 0,
        maxAnchorInterval: 500_000,
        segments: [
          segment(0, 0),
          segment(1, 900_000)
        ]
      }),
    (err) => err.code === 'ANCHOR_INCOMPATIBLE' && err.segment === 1
  );
});

test('maxAnchorInterval large enough for two wrap counts is AMBIGUOUS_UNWRAP', () => {
  // raw goes to 0 after wrap; candidates at +M and +2M both fit when the
  // interval permits two modulus steps.
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 100,
        maxAnchorInterval: 2 * M,
        segments: [segment(0, 100), segment(1, 100)]
      }),
    (err) => err.code === 'AMBIGUOUS_UNWRAP' && err.segment === 1
  );
});

test('wrap candidates are ordered by wrap count, smallest unique wins', () => {
  // near-end -> small value: candidate k=1 fits; k=2 exceeds the limit.
  const nearEnd = M - 100_000;
  const result = normalizeRequest({
    firstSegmentAnchor: nearEnd,
    maxAnchorInterval: M, // k=1 distance 200000 fits; k=2 does not
    segments: [
      segment(0, nearEnd),
      segment(1, 100_000, { cues: [cue('00:00:00.000', '00:00:01.000', 'x')] })
    ]
  });
  assert.equal(result.cues[0].startTicks, M + 100_000);
});

test('equal raw counters with a sub-modulus interval resolve to zero advance', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: 5_000_000,
    maxAnchorInterval: M - 1,
    segments: [
      segment(0, 5_000_000, { cues: [cue('00:00:00.000', '00:00:01.000', 'a')] }),
      segment(1, 5_000_000, {
        local: '00:00:02.000',
        cues: [cue('00:00:02.000', '00:00:03.000', 'b')]
      })
    ]
  });
  assert.deepEqual(result.cues.map((c) => c.startTicks), [5_000_000, 5_000_000]);
});

test('ambiguity is detected immediately even with a huge interval bound', () => {
  const started = Date.now();
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 0,
        maxAnchorInterval: Number.MAX_SAFE_INTEGER,
        segments: [segment(0, 0), segment(1, 0)]
      }),
    (err) => err.code === 'AMBIGUOUS_UNWRAP' && err.segment === 1
  );
  assert.ok(Date.now() - started < 1000, 'resolution must be constant-time');
});

test('rejects non-consecutive and duplicate sequences', () => {
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 0,
        maxAnchorInterval: 9_000_000,
        segments: [segment(0, 0), segment(2, 900_000)]
      }),
    (err) => err.code === 'INVALID_SEQUENCE' && err.segment === 2
  );
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 0,
        maxAnchorInterval: 9_000_000,
        segments: [segment(0, 0), segment(0, 900_000)]
      }),
    (err) => err.code === 'DUPLICATE_SEQUENCE' && err.segment === 0
  );
});

test('segment count must be 1..64', () => {
  const mk = (n) => ({
    firstSegmentAnchor: 0,
    maxAnchorInterval: 90_000 * 10,
    segments: Array.from({ length: n }, (_, i) => segment(i, i * 90_000))
  });
  assert.throws(() => normalizeRequest(mk(0)), (err) => err.code === 'EMPTY_SEGMENT_LIST');
  assert.throws(() => normalizeRequest(mk(65)), (err) => err.code === 'SEGMENT_COUNT_OUT_OF_RANGE');
  assert.doesNotThrow(() => normalizeRequest(mk(64)));
  assert.doesNotThrow(() => normalizeRequest(mk(1)));
});

test('total UTF-8 text is capped at 1 MiB', () => {
  const payload = 'あ'.repeat(200_000); // 3 bytes per char = 600_000 bytes
  const s1 = segment(0, 0, { cues: [cue('00:00:01.000', '00:00:02.000', payload)] });
  const s2 = segment(1, 90_000, { cues: [cue('00:00:01.000', '00:00:02.000', payload)] });
  assert.throws(
    () =>
      normalizeRequest({
        firstSegmentAnchor: 0,
        maxAnchorInterval: 9_000_000,
        segments: [s1, s2]
      }),
    (err) => err.code === 'TOTAL_PAYLOAD_TOO_LARGE' && err.segment === 1
  );
});

test('output is sorted by startTicks regardless of segment input order', () => {
  const result = normalizeRequest({
    firstSegmentAnchor: 0,
    maxAnchorInterval: 9_000_000,
    segments: [
      segment(1, 900_000, { cues: [cue('00:00:01.000', '00:00:02.000', 'late')] }),
      segment(0, 0, { cues: [cue('00:00:00.000', '00:00:01.000', 'early')] })
    ]
  });
  assert.deepEqual(
    result.cues.map((c) => c.text),
    ['early', 'late']
  );
});

test('multi-hop unwrapping chains through several wrapped segments', () => {
  const anchors = [M - 200_000, 100_000, 400_000, 50_000];
  const result = normalizeRequest({
    firstSegmentAnchor: anchors[0],
    maxAnchorInterval: M,
    segments: anchors.map((a, i) =>
      segment(i, a, { cues: [cue('00:00:00.000', '00:00:01.000', `c${i}`)] })
    )
  });
  assert.deepEqual(
    result.cues.map((c) => c.startTicks),
    [M - 200_000, M + 100_000, M + 400_000, 2 * M + 50_000]
  );
});
