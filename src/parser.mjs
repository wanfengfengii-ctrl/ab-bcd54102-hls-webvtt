// Parser for HLS segmented WebVTT payloads.
//
// A segment looks like:
//
//   WEBVTT
//   X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000
//
//   00:00:01.000 --> 00:00:05.000
//   Cue text
//
// All validation failures become NormalizeError carrying the segment
// sequence number so the API can report a stable code + segment.
import { NormalizeError, ErrorCode as EC, MPEGTS_MOD } from './errors.mjs';

const TICKS_PER_MILLISECOND = 90;
const MAX_LOCAL_HOURS = 9999;

// (HH:)MM:SS.mmm — milliseconds are mandatory everywhere in this service
// (WebVTT requires a fractional second; HLS authoring uses exactly three
// digits).
const TIMESTAMP_RE = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/;

function parseTimestamp(raw, { segment, formatCode, rangeCode, label }) {
  const match = TIMESTAMP_RE.exec(raw);
  if (!match) {
    throw new NormalizeError(formatCode, `${label} is not a valid MM:SS.mmm timestamp`, {
      segment,
      detail: { value: raw }
    });
  }
  const hours = match[1] !== undefined ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (hours > MAX_LOCAL_HOURS || minutes > 59 || seconds > 59) {
    throw new NormalizeError(rangeCode, `${label} component out of range`, {
      segment,
      detail: { value: raw }
    });
  }
  const totalMillis = (((hours * 60 + minutes) * 60 + seconds) * 1000 + millis);
  return totalMillis * TICKS_PER_MILLISECOND;
}

function splitLines(text) {
  // Strip a single leading UTF-8 BOM, then normalize CRLF / CR endings.
  return text.replace(/^\uFEFF?/, '').split(/\r\n|\r|\n/);
}

function isBlank(line) {
  return line.trim().length === 0;
}

// Parse the X-TIMESTAMP-MAP header value: MPEGTS:<uint33>,LOCAL:<ts>
// in either attribute order.
function parseTimestampMap(rawMap, segment) {
  const parts = rawMap.split(',');
  const attrs = new Map();
  for (const part of parts) {
    const colon = part.indexOf(':');
    if (colon <= 0) {
      throw new NormalizeError(
        EC.INVALID_WEBVTT_HEADER,
        'Malformed X-TIMESTAMP-MAP attribute',
        { segment, detail: { attribute: part } }
      );
    }
    const key = part.slice(0, colon);
    const value = part.slice(colon + 1);
    if (key !== 'MPEGTS' && key !== 'LOCAL') {
      throw new NormalizeError(
        EC.INVALID_WEBVTT_HEADER,
        'Unknown X-TIMESTAMP-MAP attribute',
        { segment, detail: { attribute: key } }
      );
    }
    if (attrs.has(key)) {
      throw new NormalizeError(
        EC.INVALID_WEBVTT_HEADER,
        `Duplicate X-TIMESTAMP-MAP attribute ${key}`,
        { segment }
      );
    }
    attrs.set(key, value);
  }

  if (!attrs.has('MPEGTS') || !attrs.has('LOCAL')) {
    throw new NormalizeError(
      EC.INVALID_WEBVTT_HEADER,
      'X-TIMESTAMP-MAP requires both MPEGTS and LOCAL',
      { segment }
    );
  }

  const mpegtsRaw = attrs.get('MPEGTS');
  if (!/^\d+$/.test(mpegtsRaw)) {
    throw new NormalizeError(EC.INVALID_MPEGTS, 'MPEGTS must be a non-negative integer', {
      segment,
      detail: { value: mpegtsRaw }
    });
  }
  const mpegts = Number(mpegtsRaw);
  if (mpegts >= MPEGTS_MOD) {
    throw new NormalizeError(
      EC.INVALID_MPEGTS,
      `MPEGTS must fit in 33 bits (0..${MPEGTS_MOD - 1})`,
      { segment, detail: { value: mpegtsRaw } }
    );
  }

  const localTicks = parseTimestamp(attrs.get('LOCAL'), {
    segment,
    formatCode: EC.INVALID_LOCAL,
    rangeCode: EC.INVALID_LOCAL,
    label: 'LOCAL'
  });

  return { mpegts, localTicks };
}

const CUE_SETTING_TOKEN_RE = /^[A-Za-z][A-Za-z0-9-]*:\S+$/;

function parseCueTiming(line, segment) {
  const arrow = line.indexOf('-->');
  if (arrow < 0) return null;

  const startRaw = line.slice(0, arrow).trim();
  const rest = line.slice(arrow + 3).trim();
  // The end timestamp contains no whitespace; anything after it is cue
  // settings (position, line, align, ...).
  const space = rest.search(/\s/);
  const endRaw = space < 0 ? rest : rest.slice(0, space);
  const settings = space < 0 ? '' : rest.slice(space + 1).trim();

  if (settings.length > 0) {
    const tokens = settings.split(/[ \t]+/);
    if (!tokens.every((t) => CUE_SETTING_TOKEN_RE.test(t))) {
      throw new NormalizeError(EC.INVALID_CUE_TIME, 'Invalid cue settings', {
        segment,
        detail: { value: line }
      });
    }
  }

  const startTicks = parseTimestamp(startRaw, {
    segment,
    formatCode: EC.INVALID_CUE_TIME,
    rangeCode: EC.CUE_TIME_OUT_OF_RANGE,
    label: 'Cue start'
  });
  const endTicks = parseTimestamp(endRaw, {
    segment,
    formatCode: EC.INVALID_CUE_TIME,
    rangeCode: EC.CUE_TIME_OUT_OF_RANGE,
    label: 'Cue end'
  });
  return { startTicks, endTicks };
}

// Parse one WebVTT segment. Returns { mpegts, localTicks, cues } where
// cue times are still segment-local 90 kHz ticks.
export function parseSegment(text, sequence) {
  const lines = splitLines(text);

  // Split header block (up to the first blank line) from cue blocks.
  let firstBlank = 0;
  while (firstBlank < lines.length && !isBlank(lines[firstBlank])) firstBlank += 1;
  const header = lines.slice(0, firstBlank);

  if (header.length === 0 || !/^WEBVTT(?:[ \t].*)?$/.test(header[0])) {
    throw new NormalizeError(
      EC.INVALID_WEBVTT_HEADER,
      'Segment must start with a WEBVTT header',
      { segment: sequence }
    );
  }

  // Exactly one X-TIMESTAMP-MAP per segment, and it must live in the
  // header block (before the first blank line).
  const mapLineIndexes = [];
  lines.forEach((l, idx) => {
    if (l.startsWith('X-TIMESTAMP-MAP=')) mapLineIndexes.push(idx);
  });
  if (mapLineIndexes.length === 0) {
    throw new NormalizeError(
      EC.MISSING_TIMESTAMP_MAP,
      'Segment is missing X-TIMESTAMP-MAP',
      { segment: sequence }
    );
  }
  if (mapLineIndexes.length > 1) {
    throw new NormalizeError(
      EC.MULTIPLE_TIMESTAMP_MAPS,
      'Segment must contain exactly one X-TIMESTAMP-MAP',
      { segment: sequence }
    );
  }
  if (mapLineIndexes[0] >= firstBlank) {
    throw new NormalizeError(
      EC.INVALID_WEBVTT_HEADER,
      'X-TIMESTAMP-MAP must appear in the WebVTT header',
      { segment: sequence }
    );
  }
  const mapLine = lines[mapLineIndexes[0]];
  const { mpegts, localTicks } = parseTimestampMap(
    mapLine.slice('X-TIMESTAMP-MAP='.length),
    sequence
  );

  const cues = [];
  let i = firstBlank;
  while (i < lines.length) {
    while (i < lines.length && isBlank(lines[i])) i += 1;
    const block = [];
    while (i < lines.length && !isBlank(lines[i])) {
      block.push(lines[i]);
      i += 1;
    }
    if (block.length === 0) continue;

    // NOTE comment blocks are legal anywhere after the header.
    if (/^NOTE(?:[ \t].*)?$/.test(block[0])) continue;
    // STYLE / REGION blocks carry no cues; ignore them.
    if (/^(?:STYLE|REGION)(?:[ \t].*)?$/.test(block[0])) continue;

    let timingLineIndex = 0;
    if (!block[0].includes('-->')) {
      if (block.length > 1 && block[1].includes('-->')) {
        timingLineIndex = 1; // block[0] is the optional cue identifier
      } else {
        throw new NormalizeError(
          EC.INVALID_CUE_TIME,
          'Cue block is missing a timing line',
          { segment: sequence, detail: { value: block[0] } }
        );
      }
    }

    const timing = parseCueTiming(block[timingLineIndex], sequence);
    const payloadLines = block.slice(timingLineIndex + 1);
    // A timing line without any payload is not a cue; ignore it.
    if (payloadLines.length === 0) continue;

    if (timing.startTicks >= timing.endTicks) {
      throw new NormalizeError(
        EC.INVALID_CUE_RANGE,
        'Cue start must be strictly before cue end',
        { segment: sequence, detail: { value: block[timingLineIndex] } }
      );
    }

    cues.push({
      index: cues.length,
      startTicks: timing.startTicks,
      endTicks: timing.endTicks,
      text: payloadLines.join('\n')
    });
  }

  return { sequence, mpegts, localTicks, cues };
}
