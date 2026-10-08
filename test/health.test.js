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
const mongoose = require('mongoose');
const health = require('../src/features/health/health.service');

let server;
let origin;
before(async () => {
  require('node:test').mock.method(require('../src/services/token-rate-limit.service'), 'checkDocumentationLimit', async () => 0);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('public health checks the database on every request without caching or conditional 304', async t => {
  let checks = 0;
  t.mock.method(health, 'checkDatabase', async () => { checks++; return true; });
  const response = await fetch(`${origin}${apiBaseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.deepEqual(await response.json(), { status: 'ok', database: 'up' });
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('last-modified'), null);
  const conditional = await new Promise((resolve, reject) => {
    http.get(`${origin}${apiBaseUrl}/health`, { headers: { 'If-None-Match': '*', 'If-Modified-Since': 'Thu, 08 Oct 2099 00:00:00 GMT' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on('error', reject);
    }).on('error', reject);
  });
  assert.equal(conditional.status, 200);
  assert.deepEqual(JSON.parse(conditional.body), { status: 'ok', database: 'up' });
  assert.equal(conditional.headers.etag, undefined);
  assert.equal(checks, 2);
  health.checkDatabase.mock.mockImplementation(async () => false);
  const unavailable = await fetch(`${origin}${apiBaseUrl}/health`, { headers: { 'If-None-Match': '*' } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  assert.equal(unavailable.headers.get('etag'), null);
  assert.equal(unavailable.headers.get('last-modified'), null);
  assert.deepEqual(await unavailable.json(), { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable.', details: [] });
});

test('database check requires a live connection and a successful ping with a bounded driver timeout', async t => {
  const connection = mongoose.connection;
  const originalDb = Object.getOwnPropertyDescriptor(connection, 'db');
  const originalState = Object.getOwnPropertyDescriptor(connection, 'readyState');
  t.after(() => {
    for (const [key, descriptor] of [['db', originalDb], ['readyState', originalState]]) {
      if (descriptor) Object.defineProperty(connection, key, descriptor);
      else delete connection[key];
    }
  });
  let calls = 0;
  const db = { async command(command, options) {
    calls++;
    assert.deepEqual(command, { ping: 1 });
    assert.deepEqual(options, { timeoutMS: 2000 });
    return { ok: 1 };
  } };
  Object.defineProperty(connection, 'db', { configurable: true, writable: true, value: db });
  Object.defineProperty(connection, 'readyState', { configurable: true, writable: true, value: 0 });
  assert.equal(await health.checkDatabase(), false);
  assert.equal(calls, 0);
  connection.readyState = 1;
  assert.equal(await health.checkDatabase(), true);
  assert.equal(calls, 1);
  db.command = async () => ({ ok: 0 });
  assert.equal(await health.checkDatabase(), false);
  for (const name of ['MongoOperationTimeoutError', 'MongoNetworkError']) {
    db.command = async () => { const error = new Error('private connection details'); error.name = name; throw error; };
    assert.equal(await health.checkDatabase(), false);
  }
  connection.db = undefined;
  assert.equal(await health.checkDatabase(), false);
});

test('health respects JSON negotiation without querying the database', async t => {
  t.mock.method(health, 'checkDatabase', () => assert.fail('Negotiation precedes database checks'));
  const rejected = await fetch(`${origin}${apiBaseUrl}/health`, { headers: { Accept: 'text/html' } });
  assert.equal(rejected.status, 406);
  assert.equal(rejected.headers.get('cache-control'), 'no-store');
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
  assert.ok(spec.paths['/health'].get.responses['503']);
  assert.equal(spec.paths['/health'].get.responses['304'], undefined);
  assert.equal(spec.paths['/health'].get.parameters, undefined);
});

test('environment override controls route mounting and OpenAPI together', () => {
  const script = `
    const app = require('./src/app');
    require('./src/features/health/health.service').checkDatabase = async () => true;
    require('./src/services/token-rate-limit.service').checkDocumentationLimit = async () => 0;
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const origin = 'http://127.0.0.1:' + server.address().port;
        const health = await fetch(origin + '/custom/v2/health');
        const old = await fetch(origin + '/api/v1.0/health');
        const spec = await (await fetch(origin + '/custom/v2/openapi.json')).json();
        const docs = await fetch(origin + '/custom/v2/docs', { headers: { Accept: 'text/html' } });
        const html = await docs.text();
        const css = await fetch(origin + '/custom/v2/docs/swagger-ui.css');
        await css.text();
        console.log(JSON.stringify({ health: health.status, old: old.status, servers: spec.servers,
          docs: docs.status, css: css.status, configuredUi: html.includes('url: "/custom/v2/openapi.json"') }));
      } catch (error) { console.error(error); process.exitCode = 1; }
      finally { server.close(); }
    });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, API_BASE_URL: '/custom/v2' }, encoding: 'utf8', timeout: 15000,
  });
  assert.deepEqual(JSON.parse(output), { health: 200, old: 404, servers: [{ url: '/custom/v2' }], docs: 200, css: 200, configuredUi: true });
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
