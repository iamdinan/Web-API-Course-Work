const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
process.env.JWT_SIGNING_KEY = 'health-test-only-key-with-at-least-32-bytes';
process.env.JWT_ISSUER = 'test-issuer';
process.env.JWT_AUDIENCE = 'test-audience';
const app = require('../src/app');
const { apiBaseUrl } = require('../src/config/env');

let server;
let origin;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('public health returns JSON and a stable strong ETag', async () => {
  const response = await fetch(`${origin}${apiBaseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), { status: 'ok' });
  const tag = response.headers.get('etag');
  assert.match(tag, /^"[^"]+"$/);
  const repeated = await fetch(`${origin}${apiBaseUrl}/health`);
  assert.equal(repeated.headers.get('etag'), tag);
  await repeated.text();
  // fetch adds Cache-Control: no-cache to conditional requests, bypassing freshness.
  const conditional = await new Promise((resolve, reject) => {
    http.get(`${origin}${apiBaseUrl}/health`, { headers: { 'If-None-Match': tag } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body, '');
  assert.equal(conditional.headers.etag, tag);
  const changed = await fetch(`${origin}${apiBaseUrl}/health`, { headers: { 'If-None-Match': '"different"' } });
  assert.equal(changed.status, 200);
  await changed.text();
});

test('health respects JSON negotiation', async () => {
  const rejected = await fetch(`${origin}${apiBaseUrl}/health`, { headers: { Accept: 'text/html' } });
  assert.equal(rejected.status, 406);
  assert.equal(await rejected.text(), '');
});

test('unknown routes and invalid JSON use the common error shape', async () => {
  const missing = await fetch(`${origin}/health`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { code: 'NOT_FOUND', message: 'Route not found.', details: [] });
  const malformed = await fetch(`${origin}${apiBaseUrl}/health`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { code: 'INVALID_JSON', message: 'Request body must be valid JSON.', details: [] });
});

test('served OpenAPI describes health under the configured prefix', async () => {
  const response = await fetch(`${origin}${apiBaseUrl}/openapi.json`);
  assert.equal(response.status, 200);
  const spec = await response.json();
  assert.deepEqual(spec.servers, [{ url: apiBaseUrl }]);
  assert.ok(spec.paths['/health'].get.responses['200']);
  assert.ok(spec.paths['/health'].get.responses['304']);
});

test('environment override controls route mounting and OpenAPI together', () => {
  const script = `
    const app = require('./src/app');
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const origin = 'http://127.0.0.1:' + server.address().port;
        const health = await fetch(origin + '/custom/v2/health');
        const old = await fetch(origin + '/api/v1.0/health');
        const spec = await (await fetch(origin + '/custom/v2/openapi.json')).json();
        console.log(JSON.stringify({ health: health.status, old: old.status, servers: spec.servers }));
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); }
    });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, API_BASE_URL: '/custom/v2' }, encoding: 'utf8', timeout: 15000,
  });
  assert.deepEqual(JSON.parse(output), { health: 200, old: 404, servers: [{ url: '/custom/v2' }] });
});

test('configuration rejects invalid base paths and ports before startup', () => {
  for (const override of [{ API_BASE_URL: 'https://example.com' }, { API_BASE_URL: '/api/' }, { PORT: 'invalid' }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./src/config/env')"], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, ...override }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API_BASE_URL must|PORT must/);
  }
});
