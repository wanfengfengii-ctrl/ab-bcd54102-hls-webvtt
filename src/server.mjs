// Zero-dependency HTTP service exposing POST /api/subtitles/normalize
// and GET /health for container health checks.
import { createServer } from 'node:http';
import { normalizeRequest } from './normalize.mjs';
import { NormalizeError, ErrorCode as EC, MAX_TOTAL_PAYLOAD_BYTES } from './errors.mjs';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
// JSON envelope overhead on top of the 1 MiB of raw segment text.
const MAX_BODY_BYTES = MAX_TOTAL_PAYLOAD_BYTES + 64 * 1024;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, code, message, segment = null, detail = null) {
  const payload = { error: { code, message } };
  if (segment !== null) payload.error.segment = segment;
  if (detail !== null) payload.error.detail = detail;
  sendJson(res, status, payload);
}

// 4xx status selection keyed off the stable error code.
const BAD_REQUEST_CODES = new Set([
  EC.INVALID_JSON,
  EC.INVALID_REQUEST,
  EC.TOTAL_PAYLOAD_TOO_LARGE,
  EC.EMPTY_SEGMENT_LIST,
  EC.SEGMENT_COUNT_OUT_OF_RANGE,
  EC.INVALID_SEQUENCE,
  EC.DUPLICATE_SEQUENCE,
  EC.MISSING_TIMESTAMP_MAP,
  EC.MULTIPLE_TIMESTAMP_MAPS,
  EC.INVALID_WEBVTT_HEADER,
  EC.INVALID_MPEGTS,
  EC.INVALID_LOCAL,
  EC.INVALID_CUE_TIME,
  EC.INVALID_CUE_RANGE,
  EC.CUE_TIME_OUT_OF_RANGE
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new NormalizeError(EC.TOTAL_PAYLOAD_TOO_LARGE, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleNormalize(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    sendError(res, 400, EC.INVALID_JSON, 'Request body is not valid JSON');
    return;
  }

  try {
    const result = normalizeRequest(body);
    sendJson(res, 200, {
      segmentCount: result.segmentCount,
      firstSequence: result.firstSequence,
      cues: result.cues
    });
  } catch (err) {
    if (err instanceof NormalizeError) {
      const status = BAD_REQUEST_CODES.has(err.code)
        ? 400
        : err.code === EC.ANCHOR_INCOMPATIBLE || err.code === EC.AMBIGUOUS_UNWRAP
          ? 422
          : 400;
      sendError(res, status, err.code, err.message, err.segment, err.detail);
      return;
    }
    throw err;
  }
}

export function createApp() {
  return createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (req.method === 'GET' && pathname === '/') {
      sendJson(res, 200, { service: 'hls-webvtt-normalizer', endpoints: ['/health', '/api/subtitles/normalize'] });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/subtitles/normalize') {
      handleNormalize(req, res).catch((err) => {
        if (!res.headersSent) {
          sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
        }
        // eslint-disable-next-line no-console
        console.error(err);
      });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', `Unknown route ${req.method} ${pathname}`);
  });
}

// Allow importing the app without listening (tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`subtitle-normalizer listening on http://${HOST}:${PORT}`);
  });
}
