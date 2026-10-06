// Timeline normalization: map every segment's cues onto one absolute
// 90 kHz timeline anchored by the first segment, uniquely resolving
// 33-bit MPEGTS counter wrap-around between consecutive segments.
import { parseSegment } from './parser.mjs';
import {
  NormalizeError,
  ErrorCode as EC,
  MAX_TOTAL_PAYLOAD_BYTES,
  MIN_SEGMENTS,
  MAX_SEGMENTS,
  MPEGTS_MOD
} from './errors.mjs';

function assertInteger(value, field, { min = null, max = null } = {}) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    throw new NormalizeError(EC.INVALID_REQUEST, `${field} must be an integer`, {
      detail: { field }
    });
  }
  if (!Number.isSafeInteger(n)) {
    throw new NormalizeError(EC.INVALID_REQUEST, `${field} must be a safe integer`, {
      detail: { field, value }
    });
  }
  if (min !== null && n < min) {
    throw new NormalizeError(EC.INVALID_REQUEST, `${field} must be >= ${min}`, {
      detail: { field, value: n }
    });
  }
  if (max !== null && n > max) {
    throw new NormalizeError(EC.INVALID_REQUEST, `${field} must be <= ${max}`, {
      detail: { field, value: n }
    });
  }
  return n;
}

// Resolve the unwrapped absolute anchor of a segment given the previous
// one. The 33-bit MPEGTS counter increments monotonically; a drop of the
// raw value means one or more modulus wraps happened. The real distance
// must satisfy:
//
//   distance = delta + k * MOD,   k >= 0,   0 <= distance <= maxInterval
//
// where delta is the forward modular distance between the raw counters.
// Exactly one k may satisfy the interval. Zero solutions means the
// anchors are incompatible; two or more means the wrap count cannot be
// determined uniquely.
function resolveAnchor(prevAbsolute, raw, sequence, maxAnchorInterval) {
  const prevMod = ((prevAbsolute % MPEGTS_MOD) + MPEGTS_MOD) % MPEGTS_MOD;
  const delta = ((raw - prevMod) % MPEGTS_MOD + MPEGTS_MOD) % MPEGTS_MOD;

  if (delta > maxAnchorInterval) {
    throw new NormalizeError(
      EC.ANCHOR_INCOMPATIBLE,
      'No timeline placement satisfies the maximum anchor interval',
      {
        segment: sequence,
        detail: { previousAnchor: prevAbsolute, mpegts: raw, maxAnchorInterval }
      }
    );
  }

  // Number of additional whole-modulus steps that still fit under the
  // interval bound, on top of k = 0.
  const additionalWraps = Math.floor((maxAnchorInterval - delta) / MPEGTS_MOD);
  if (additionalWraps >= 1) {
    throw new NormalizeError(
      EC.AMBIGUOUS_UNWRAP,
      'Multiple wrap counts satisfy the maximum anchor interval',
      {
        segment: sequence,
        detail: {
          previousAnchor: prevAbsolute,
          mpegts: raw,
          maxAnchorInterval,
          candidates: [prevAbsolute + delta, prevAbsolute + delta + MPEGTS_MOD]
        }
      }
    );
  }

  const anchor = prevAbsolute + delta;
  if (anchor > Number.MAX_SAFE_INTEGER) {
    throw new NormalizeError(
      EC.INVALID_REQUEST,
      'Unwrapped timeline exceeds the safe integer range',
      { segment: sequence, detail: { anchor } }
    );
  }
  return anchor;
}

export function normalizeRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new NormalizeError(EC.INVALID_REQUEST, 'Request body must be a JSON object');
  }

  const firstAnchor = assertInteger(body.firstSegmentAnchor, 'firstSegmentAnchor', { min: 0 });
  const maxAnchorInterval = assertInteger(body.maxAnchorInterval, 'maxAnchorInterval', { min: 1 });

  const segmentsInput = body.segments;
  if (!Array.isArray(segmentsInput)) {
    throw new NormalizeError(EC.INVALID_REQUEST, 'segments must be an array', {
      detail: { field: 'segments' }
    });
  }
  if (segmentsInput.length === 0) {
    throw new NormalizeError(EC.EMPTY_SEGMENT_LIST, 'segments must contain 1..64 entries');
  }
  if (segmentsInput.length < MIN_SEGMENTS || segmentsInput.length > MAX_SEGMENTS) {
    throw new NormalizeError(
      EC.SEGMENT_COUNT_OUT_OF_RANGE,
      `segments must contain ${MIN_SEGMENTS}..${MAX_SEGMENTS} entries`,
      { detail: { count: segmentsInput.length } }
    );
  }

  let totalBytes = 0;
  const entries = segmentsInput.map((seg, i) => {
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
      throw new NormalizeError(
        EC.INVALID_REQUEST,
        `segments[${i}] must be an object with sequence and text`,
        { detail: { index: i } }
      );
    }
    const sequence = assertInteger(seg.sequence, `segments[${i}].sequence`);
    if (typeof seg.text !== 'string') {
      throw new NormalizeError(
        EC.INVALID_REQUEST,
        `segments[${i}].text must be a UTF-8 string`,
        { segment: sequence, detail: { index: i } }
      );
    }
    const byteLength = Buffer.byteLength(seg.text, 'utf8');
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      throw new NormalizeError(
        EC.TOTAL_PAYLOAD_TOO_LARGE,
        'Total UTF-8 text of all segments exceeds 1 MiB',
        { segment: sequence, detail: { bytes: totalBytes, limit: MAX_TOTAL_PAYLOAD_BYTES } }
      );
    }
    return { sequence, text: seg.text };
  });

  // Sequence numbers must be consecutive. Sort a copy for the check but
  // keep the original order for deterministic per-segment error reporting.
  const bySequence = entries.slice().sort((a, b) => a.sequence - b.sequence);
  const seen = new Set();
  for (const { sequence } of bySequence) {
    if (seen.has(sequence)) {
      throw new NormalizeError(
        EC.DUPLICATE_SEQUENCE,
        `Duplicate segment sequence ${sequence}`,
        { segment: sequence }
      );
    }
    seen.add(sequence);
  }
  for (let i = 1; i < bySequence.length; i += 1) {
    if (bySequence[i].sequence !== bySequence[i - 1].sequence + 1) {
      throw new NormalizeError(
        EC.INVALID_SEQUENCE,
        'Segment sequence numbers must be consecutive',
        {
          segment: bySequence[i].sequence,
          detail: { previous: bySequence[i - 1].sequence, current: bySequence[i].sequence }
        }
      );
    }
  }

  // Parse every segment (in supplied order so errors are reported at the
  // first malformed segment the client sent).
  const parsedBySequence = new Map();
  for (const { sequence, text } of entries) {
    parsedBySequence.set(sequence, parseSegment(text, sequence));
  }

  // Anchor consistency for the very first segment: firstSegmentAnchor is
  // the absolute 90 kHz value of that segment's MPEGTS counter, so its
  // low 33 bits must equal the raw MPEGTS in the header.
  const first = parsedBySequence.get(bySequence[0].sequence);
  if (firstAnchor % MPEGTS_MOD !== first.mpegts) {
    throw new NormalizeError(
      EC.ANCHOR_INCOMPATIBLE,
      'firstSegmentAnchor is incompatible with the first segment MPEGTS value',
      {
        segment: first.sequence,
        detail: { firstSegmentAnchor: firstAnchor, mpegts: first.mpegts }
      }
    );
  }

  const absoluteAnchorBySequence = new Map();
  absoluteAnchorBySequence.set(first.sequence, firstAnchor);

  const ordered = bySequence.map(({ sequence }) => parsedBySequence.get(sequence));
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const cur = ordered[i];
    const anchor = resolveAnchor(
      absoluteAnchorBySequence.get(prev.sequence),
      cur.mpegts,
      cur.sequence,
      maxAnchorInterval
    );
    absoluteAnchorBySequence.set(cur.sequence, anchor);
  }

  // Expand cues to absolute ticks.
  const cues = [];
  for (const seg of ordered) {
    const anchor = absoluteAnchorBySequence.get(seg.sequence);
    for (const cue of seg.cues) {
      const startTicks = anchor - seg.localTicks + cue.startTicks;
      const endTicks = anchor - seg.localTicks + cue.endTicks;
      cues.push({
        startTicks,
        endTicks,
        sequence: seg.sequence,
        order: cue.index,
        text: cue.text
      });
    }
  }

  // Stable ordering: absolute start, then originating segment, then the
  // cue's position inside the segment.
  cues.sort((a, b) => {
    if (a.startTicks !== b.startTicks) return a.startTicks - b.startTicks;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.order - b.order;
  });

  return {
    segmentCount: ordered.length,
    firstSequence: first.sequence,
    anchors: ordered.map((p) => ({
      sequence: p.sequence,
      anchor: absoluteAnchorBySequence.get(p.sequence)
    })),
    cues: cues.map(({ startTicks, endTicks, text }) => ({ startTicks, endTicks, text }))
  };
}
