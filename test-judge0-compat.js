/**
 * test-judge0-compat.js
 *
 * End-to-end smoke tests against the live server.
 * Covers all APIs added across all sessions.
 *
 * Run:  node test-judge0-compat.js
 */

const http = require('http');

const BASE  = 'http://127.0.0.1:3000';
const ADMIN = 'jurge-admin-secret';

let passed = 0;
let failed = 0;

// ── Helpers ────────────────────────────────────────────────────────────────

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: 3000,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function poll(token, maxAttempts = 20, intervalMs = 500) {
  for (let i = 0; i < maxAttempts; i++) {
    const r = await request('GET', `/api/submissions/${token}`);
    const sid = r.body?.status?.id;
    if (sid && sid !== 1 && sid !== 2) return r; // not In Queue / Processing
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

function check(name, condition, extra = '') {
  if (condition) {
    console.log(`  ✅  ${name}`);
    passed++;
  } else {
    console.error(`  ❌  ${name}${extra ? '  →  ' + extra : ''}`);
    failed++;
  }
}

// ── Test suites ────────────────────────────────────────────────────────────

async function testHealth() {
  console.log('\n── Health & Security ──────────────────────────────────────');
  const h = await request('GET', '/api/health');
  check('GET /api/health → 200', h.status === 200);
  check('health body has status:ok', h.body?.status === 'ok');

  const unauth = await request('GET', '/admin/metrics/queues');
  check('GET /admin/* without key → 401', unauth.status === 401);

  const auth = await request('GET', '/admin/metrics/queues', null, { 'x-admin-api-key': ADMIN });
  check('GET /admin/metrics/queues with key → 200', auth.status === 200, JSON.stringify(auth.body));
}

async function testNativeFormat() {
  console.log('\n── Native Format (POST /api/submissions) ──────────────────');
  const r = await request('POST', '/api/submissions', {
    language: 'python',
    sourceCode: 'print("hello")',
    stdin: '',
  });
  check('Native format → 202', r.status === 202, JSON.stringify(r.body));
  check('Response has token', !!r.body?.token);
  return r.body?.token;
}

async function testJudge0SingleFormat() {
  console.log('\n── Judge0 Single Format ───────────────────────────────────');

  // language_id: 71 → python
  const r = await request('POST', '/api/submissions', {
    source_code: 'print("judge0")',
    language_id: 71,
    stdin: '',
  });
  check('Judge0 format (language_id:71) → 202', r.status === 202, JSON.stringify(r.body));
  check('Response has token', !!r.body?.token);

  // Unknown language_id
  const bad = await request('POST', '/api/submissions', {
    source_code: 'x',
    language_id: 9999,
  });
  check('Unknown language_id → 400', bad.status === 400, JSON.stringify(bad.body));
  check('Error is unknown_language_id', bad.body?.error === 'unknown_language_id');

  return r.body?.token;
}

async function testExpectedOutput() {
  console.log('\n── expected_output / Wrong Answer ─────────────────────────');

  // Correct expected_output
  const correct = await request('POST', '/api/submissions', {
    source_code: 'print(42)',
    language_id: 71,
    expected_output: '42',
  });
  check('Submission with correct expected_output → 202', correct.status === 202);

  // Wrong expected_output
  const wrong = await request('POST', '/api/submissions', {
    source_code: 'print(99)',
    language_id: 71,
    expected_output: '42',
  });
  check('Submission with wrong expected_output → 202', wrong.status === 202);

  return { correctToken: correct.body?.token, wrongToken: wrong.body?.token };
}

async function testBatchNative() {
  console.log('\n── Batch API — Native Format ──────────────────────────────');
  const r = await request('POST', '/api/submissions/batch', {
    submissions: [
      { language: 'python', sourceCode: 'print(1)', stdin: '' },
      { language: 'python', sourceCode: 'print(2)', stdin: '' },
    ],
  });
  check('POST /api/submissions/batch → 202', r.status === 202, JSON.stringify(r.body));
  check('Returns array of 2', Array.isArray(r.body) && r.body.length === 2);
  check('Both have tokens', r.body?.every(x => x.token));
  return r.body?.map(x => x.token);
}

async function testBatchJudge0() {
  console.log('\n── Batch API — Judge0 Format ──────────────────────────────');
  const r = await request('POST', '/api/submissions/batch?base64_encoded=false&wait=false', {
    submissions: [
      { source_code: 'print("a")', language_id: 71, stdin: '', expected_output: 'a' },
      { source_code: 'print("b")', language_id: 71, stdin: '', expected_output: 'x' },
    ],
  });
  check('POST /api/submissions/batch (Judge0 format) → 202', r.status === 202, JSON.stringify(r.body));
  check('Returns array of 2', Array.isArray(r.body) && r.body.length === 2);
  check('Both have tokens', r.body?.every(x => x.token));
  return r.body?.map(x => x.token);
}

async function testBatchBadItems() {
  console.log('\n── Batch API — Validation ─────────────────────────────────');
  const empty = await request('POST', '/api/submissions/batch', { submissions: [] });
  check('Empty batch → 400', empty.status === 400);

  const badId = await request('POST', '/api/submissions/batch', {
    submissions: [{ source_code: 'x', language_id: 9999 }],
  });
  check('Batch with unknown language_id → 400', badId.status === 400, JSON.stringify(badId.body));
}

async function testGetBatch(tokens) {
  if (!tokens || tokens.length === 0) return;
  console.log('\n── GET /api/submissions/batch ─────────────────────────────');
  const r = await request('GET', `/api/submissions/batch?tokens=${tokens.join(',')}`);
  check('GET /api/submissions/batch → 200', r.status === 200, JSON.stringify(r.body));
  check('Body has submissions array', Array.isArray(r.body?.submissions));
  check('Count matches', r.body?.submissions?.length === tokens.length);
}

async function testAdminMetrics() {
  console.log('\n── Admin Metrics ──────────────────────────────────────────');
  const h = { 'x-admin-api-key': ADMIN };

  const queues = await request('GET', '/admin/metrics/queues', null, h);
  check('GET /admin/metrics/queues → 200', queues.status === 200, JSON.stringify(queues.body).slice(0, 200));
  check('Has _global key', '_global' in (queues.body || {}));

  const containers = await request('GET', '/admin/metrics/containers', null, h);
  check('GET /admin/metrics/containers → 200', containers.status === 200, JSON.stringify(containers.body).slice(0, 200));

  const submissions = await request('GET', '/admin/metrics/submissions', null, h);
  check('GET /admin/metrics/submissions → 200', submissions.status === 200);
  check('Has total field', 'total' in (submissions.body || {}));

  const langs = await request('GET', '/admin/languages', null, h);
  check('GET /admin/languages → 200', langs.status === 200);
  check('Languages array present', Array.isArray(langs.body?.languages));
  console.log('  ℹ️   Supported languages:', langs.body?.languages?.join(', '));
}

async function testResultPolling(tokens) {
  if (!tokens) return;
  console.log('\n── Result Polling (workers must be running) ───────────────');
  const workersNote = '⚠️  Results will be In Queue if workers are not running';
  const r = await request('GET', `/api/submissions/${tokens}`);
  check('GET /api/submissions/:token → 200', r.status === 200, workersNote);
  check('Has status object', r.body?.status?.id != null, workersNote);
  console.log(`  ℹ️   Current status: ${r.body?.status?.description} (id:${r.body?.status?.id})`);
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Jurge-Engine  •  Judge0 Compatibility Test Suite');
  console.log('═══════════════════════════════════════════════════════════');

  try {
    await testHealth();
    const nativeToken  = await testNativeFormat();
    const judge0Token  = await testJudge0SingleFormat();
    const { correctToken, wrongToken } = await testExpectedOutput();
    const batchTokens  = await testBatchNative();
    const batchTokensJ = await testBatchJudge0();
    await testBatchBadItems();

    // Merge all tokens for batch GET test
    const allTokens = [...(batchTokens || []), ...(batchTokensJ || [])].filter(Boolean);
    await testGetBatch(allTokens);
    await testAdminMetrics();
    await testResultPolling(nativeToken);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  Results: ${passed} passed  •  ${failed} failed`);
    console.log('═══════════════════════════════════════════════════════════\n');
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error('\n💥 Test runner crashed:', err.message);
    process.exit(1);
  }
})();
