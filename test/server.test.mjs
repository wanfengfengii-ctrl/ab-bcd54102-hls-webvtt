import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';

let server;
let baseUrl;

before(async () => {
  server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

const seg = (sequence, mpegts, cueText) => ({
  sequence,
  text:
    `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000\n\n` +
    `00:00:01.000 --> 00:00:02.000\n${cueText}\n`
});

test('GET /health reports ok', async () => {
  const { status, body } = await call('/health');
  assert.equal(status, 200);
  assert.deepEqual(body, { status: 'ok' });
});

test('POST normalizes cues', async () => {
  const { status, body } = await call('/api/subtitles/normalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstSegmentAnchor: 0,
      maxAnchorInterval: 9_000_000,
      segments: [seg(0, 0, 'hello')]
    })
  });
  assert.equal(status, 200);
  assert.equal(body.segmentCount, 1);
  assert.deepEqual(body.cues, [{ startTicks: 90_000, endTicks: 180_000, text: 'hello' }]);
});

test('POST wrap-around smoke case', async () => {
  const M = 2 ** 33;
  const { status, body } = await call('/api/subtitles/normalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstSegmentAnchor: M - 450_000,
      maxAnchorInterval: 10_000_000,
      segments: [
        {
          sequence: 0,
          text:
            `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${M - 450_000},LOCAL:00:00:00.000\n\n` +
            '00:00:04.000 --> 00:00:05.000\nbefore\n'
        },
        {
          sequence: 1,
          text:
            'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:100000,LOCAL:00:00:00.000\n\n' +
            '00:00:00.000 --> 00:00:02.000\nafter\n'
        }
      ]
    })
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.cues.length, 2);
  assert.equal(body.cues[0].text, 'before');
  assert.equal(body.cues[1].text, 'after');
  assert.ok(body.cues[0].startTicks < body.cues[1].startTicks);
  assert.equal(body.cues[1].startTicks, M + 100_000);
});

test('malformed JSON yields INVALID_JSON', async () => {
  const { status, body } = await call('/api/subtitles/normalize', {
    method: 'POST',
    body: '{not json'
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, 'INVALID_JSON');
});

test('validation errors carry code and segment', async () => {
  const { status, body } = await call('/api/subtitles/normalize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstSegmentAnchor: 999,
      maxAnchorInterval: 9_000_000,
      segments: [seg(0, 1000, 'x')]
    })
  });
  assert.equal(status, 422);
  assert.equal(body.error.code, 'ANCHOR_INCOMPATIBLE');
  assert.equal(body.error.segment, 0);
});

test('unknown route is 404', async () => {
  const { status, body } = await call('/nope');
  assert.equal(status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});
