// API smoke test against a running server. Hits GET /health and exercises
// POST /api/subtitles/normalize, including a 33-bit MPEGTS wrap sample.
// Exits non-zero on the first failed assertion.
const APP_URL = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '8080'}`;

const M = 2 ** 33;
let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`  ok - ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function request(method, path, body, { raw = false } = {}) {
  const res = await fetch(`${APP_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function segment(sequence, mpegts, start, end, text) {
  return {
    sequence,
    text:
      `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n` +
      `${start} --> ${end}\n${text}\n`
  };
}

async function main() {
  console.log(`Smoke testing ${APP_URL}`);

  const health = await request('GET', '/health');
  check('GET /health returns 200 ok', health.status === 200 && health.json.status === 'ok');

  // Wrap-around sample: segment 0 is near the top of the 33-bit counter,
  // segment 1's raw value wrapped back near zero.
  const nearEnd = M - 450_000;
  const ok = await request('POST', '/api/subtitles/normalize', {
    firstSegmentAnchor: nearEnd,
    maxAnchorInterval: 10_000_000,
    segments: [
      segment(0, nearEnd, '00:00:04.000', '00:00:05.000', 'before-wrap'),
      segment(1, 100_000, '00:00:00.000', '00:00:02.000', 'after-wrap')
    ]
  });
  check('wrap sample returns 200', ok.status === 200, JSON.stringify(ok.json));
  if (ok.status === 200) {
    check('wrap sample yields 2 cues', ok.json.cues.length === 2);
    check('cue order preserved across wrap', ok.json.cues[0].text === 'before-wrap');
    check('cue 1 unwrapped past modulus', ok.json.cues[1].startTicks === M + 100_000);
    check('all ticks are integers', ok.json.cues.every((c) =>
      Number.isInteger(c.startTicks) && Number.isInteger(c.endTicks)));
    check(
      'continuity across boundary',
      ok.json.cues[0].startTicks < ok.json.cues[1].startTicks
    );
  }

  // Stable error code + segment reporting.
  const bad = await request('POST', '/api/subtitles/normalize', {
    firstSegmentAnchor: 0,
    maxAnchorInterval: 1000,
    segments: [
      segment(0, 0, '00:00:01.000', '00:00:02.000', 'a'),
      segment(1, 900_000, '00:00:01.000', '00:00:02.000', 'b')
    ]
  });
  check(
    'incompatible anchor returns 422 with code and segment',
    bad.status === 422 &&
      bad.json?.error?.code === 'ANCHOR_INCOMPATIBLE' &&
      bad.json?.error?.segment === 1,
    JSON.stringify(bad.json)
  );

  const malformed = await request('POST', '/api/subtitles/normalize', '{', { raw: true });
  check(
    'malformed JSON returns INVALID_JSON',
    malformed.status === 400 && malformed.json?.error?.code === 'INVALID_JSON'
  );

  if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed');
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
