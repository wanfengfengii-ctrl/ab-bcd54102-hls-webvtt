import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSegment } from '../src/parser.mjs';
import { NormalizeError } from '../src/errors.mjs';

const M = 2 ** 33;

function vtt(body) {
  return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n${body}`;
}

test('parses a basic segment with one cue', () => {
  const seg = parseSegment(vtt('00:00:01.000 --> 00:00:05.000\nHello'), 7);
  assert.equal(seg.sequence, 7);
  assert.equal(seg.mpegts, 900000);
  assert.equal(seg.localTicks, 0);
  assert.equal(seg.cues.length, 1);
  assert.equal(seg.cues[0].startTicks, 90000);
  assert.equal(seg.cues[0].endTicks, 450000);
  assert.equal(seg.cues[0].text, 'Hello');
  assert.equal(seg.cues[0].index, 0);
});

test('requires millisecond precision on timestamps', () => {
  assert.throws(
    () => parseSegment(vtt('00:00:01 --> 00:00:05.000\nX'), 1),
    (err) => err instanceof NormalizeError && err.code === 'INVALID_CUE_TIME' && err.segment === 1
  );
});

test('rejects reversed cue intervals', () => {
  assert.throws(
    () => parseSegment(vtt('00:00:05.000 --> 00:00:01.000\nX'), 2),
    (err) => err.code === 'INVALID_CUE_RANGE' && err.segment === 2
  );
  assert.throws(
    () => parseSegment(vtt('00:00:05.000 --> 00:00:05.000\nX'), 2),
    (err) => err.code === 'INVALID_CUE_RANGE'
  );
});

test('rejects missing WEBVTT header', () => {
  const text = 'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nX';
  assert.throws(() => parseSegment(text, 3), (err) => err.code === 'INVALID_WEBVTT_HEADER');
});

test('requires exactly one X-TIMESTAMP-MAP', () => {
  const missing = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nX';
  assert.throws(() => parseSegment(missing, 0), (err) => err.code === 'MISSING_TIMESTAMP_MAP');

  const two =
    'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n' +
    'X-TIMESTAMP-MAP=MPEGTS:1,LOCAL:00:00:00.000\n\n' +
    '00:00:01.000 --> 00:00:02.000\nX';
  assert.throws(() => parseSegment(two, 0), (err) => err.code === 'MULTIPLE_TIMESTAMP_MAPS');
});

test('validates 33-bit MPEGTS values', () => {
  const text = (v) =>
    `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${v},LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nX`;
  assert.equal(parseSegment(text(M - 1), 0).mpegts, M - 1);
  assert.throws(() => parseSegment(text(M), 0), (err) => err.code === 'INVALID_MPEGTS');
  assert.throws(() => parseSegment(text('-1'), 0), (err) => err.code === 'INVALID_MPEGTS');
  assert.throws(() => parseSegment(text('abc'), 0), (err) => err.code === 'INVALID_MPEGTS');
});

test('validates LOCAL timestamp', () => {
  const text = (local) =>
    `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:${local}\n\n00:00:01.000 --> 00:00:02.000\nX`;
  assert.equal(parseSegment(text('01:02:03.456'), 0).localTicks, (((1 * 60 + 2) * 60 + 3) * 1000 + 456) * 90);
  assert.throws(() => parseSegment(text('00:61:00.000'), 0), (err) => err.code === 'INVALID_LOCAL');
  assert.throws(() => parseSegment(text('nope'), 0), (err) => err.code === 'INVALID_LOCAL');
});

test('accepts cue identifiers, NOTE blocks, settings and multiline text', () => {
  const text = [
    'WEBVTT',
    'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000',
    '',
    'NOTE a comment',
    '',
    'cue-1',
    '00:00:01.000 --> 00:00:02.000 align:start position:0%',
    'line one',
    'line two'
  ].join('\n');
  const seg = parseSegment(text, 0);
  assert.equal(seg.cues.length, 1);
  assert.equal(seg.cues[0].startTicks, 90000);
  assert.equal(seg.cues[0].text, 'line one\nline two');
});

test('handles CRLF and a leading BOM', () => {
  const text = '\uFEFFWEBVTT\r\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi\r\n';
  const seg = parseSegment(text, 0);
  assert.equal(seg.cues.length, 1);
  assert.equal(seg.cues[0].text, 'Hi');
});

test('rejects cue block without timing', () => {
  const text = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\njust some text';
  assert.throws(() => parseSegment(text, 0), (err) => err.code === 'INVALID_CUE_TIME');
});

test('rejects X-TIMESTAMP-MAP outside the header block', () => {
  const text =
    'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nX\n\n' +
    'X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000';
  assert.throws(() => parseSegment(text, 0), (err) => err.code === 'INVALID_WEBVTT_HEADER');
});
