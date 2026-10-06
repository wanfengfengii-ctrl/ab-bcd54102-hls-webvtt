// Stable error codes for the subtitle normalization API.
// Every error carries a machine-readable code and, when a single
// offending segment can be identified, its sequence number.
export const ErrorCode = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  INVALID_REQUEST: 'INVALID_REQUEST',
  TOTAL_PAYLOAD_TOO_LARGE: 'TOTAL_PAYLOAD_TOO_LARGE',
  EMPTY_SEGMENT_LIST: 'EMPTY_SEGMENT_LIST',
  SEGMENT_COUNT_OUT_OF_RANGE: 'SEGMENT_COUNT_OUT_OF_RANGE',
  INVALID_SEQUENCE: 'INVALID_SEQUENCE',
  DUPLICATE_SEQUENCE: 'DUPLICATE_SEQUENCE',
  MISSING_TIMESTAMP_MAP: 'MISSING_TIMESTAMP_MAP',
  MULTIPLE_TIMESTAMP_MAPS: 'MULTIPLE_TIMESTAMP_MAPS',
  INVALID_WEBVTT_HEADER: 'INVALID_WEBVTT_HEADER',
  INVALID_MPEGTS: 'INVALID_MPEGTS',
  INVALID_LOCAL: 'INVALID_LOCAL',
  INVALID_CUE_TIME: 'INVALID_CUE_TIME',
  INVALID_CUE_RANGE: 'INVALID_CUE_RANGE',
  CUE_TIME_OUT_OF_RANGE: 'CUE_TIME_OUT_OF_RANGE',
  ANCHOR_INCOMPATIBLE: 'ANCHOR_INCOMPATIBLE',
  AMBIGUOUS_UNWRAP: 'AMBIGUOUS_UNWRAP'
});

export const MAX_TOTAL_PAYLOAD_BYTES = 1024 * 1024; // 1 MiB of UTF-8 text
export const MIN_SEGMENTS = 1;
export const MAX_SEGMENTS = 64;
export const MPEGTS_MOD = 2 ** 33; // 33-bit MPEG-TS PCR/ PTS wrap modulus at 90 kHz

export class NormalizeError extends Error {
  constructor(code, message, { segment = null, detail = null } = {}) {
    super(message);
    this.name = 'NormalizeError';
    this.code = code;
    this.segment = segment;
    this.detail = detail;
  }
}
