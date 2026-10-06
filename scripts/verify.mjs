// One-shot verification entrypoint used by the "verify" compose service.
//
//  1. waits until the application reports healthy,
//  2. runs the code test suite (node --test),
//  3. runs a build check (syntax + module load of every source file),
//  4. runs the API smoke test (which includes a wrap-around sample),
//
// and exits non-zero if any stage fails.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_URL = process.env.APP_URL || `http://127.0.0.1:${process.env.PORT || '8080'}`;
const HEALTH_TIMEOUT_MS = 60_000;

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`failed to launch ${cmd}: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await fetch(`${APP_URL}/health`);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body?.status === 'ok') {
          console.log(`application healthy after ${attempt} attempt(s)`);
          return true;
        }
      }
    } catch {
      // application not reachable yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function listJsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJsFiles(full)));
    else if (extname(entry.name) === '.mjs') out.push(full);
  }
  return out;
}

async function buildCheck() {
  // node --check validates syntax of every JS file; a subsequent dynamic
  // import of src/ proves the application module graph resolves. Scripts
  // and tests have executable top-level code, so they are syntax-checked
  // only. Zero runtime dependencies keep this cheap.
  const srcFiles = await listJsFiles('src');
  const scriptFiles = await listJsFiles('scripts');
  const testFiles = await listJsFiles('test');
  for (const file of [...srcFiles, ...scriptFiles, ...testFiles]) {
    const code = await run(process.execPath, ['--check', file]);
    if (code !== 0) return false;
  }
  for (const file of srcFiles) {
    await import(pathToFileURL(file).href);
  }
  return true;
}

async function main() {
  console.log(`== verify: waiting for ${APP_URL}/health ==`);
  if (!(await waitForHealthy())) {
    console.error('application did not become healthy in time');
    process.exit(1);
  }

  console.log('\n== verify: code tests ==');
  const testCode = await run(process.execPath, ['--test']);

  console.log('\n== verify: build check ==');
  const buildOk = await buildCheck();
  console.log(buildOk ? 'build check passed' : 'build check failed');

  console.log('\n== verify: API smoke (includes wrap-around sample) ==');
  const smokeCode = await run(process.execPath, ['scripts/smoke.mjs']);

  const ok = testCode === 0 && buildOk && smokeCode === 0;
  console.log(`\n== verify result: ${ok ? 'PASS' : 'FAIL'} ` +
    `(tests=${testCode === 0 ? 'ok' : 'fail'}, ` +
    `build=${buildOk ? 'ok' : 'fail'}, ` +
    `smoke=${smokeCode === 0 ? 'ok' : 'fail'}) ==`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
