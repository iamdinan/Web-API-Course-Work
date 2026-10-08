const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const vm = require('node:vm');
const SwaggerParser = require('@apidevtools/swagger-parser');
process.env.JWT_SIGNING_KEY = 'documentation-test-key-at-least-32-bytes';
process.env.JWT_ISSUER = 'documentation-tests';
process.env.JWT_AUDIENCE = 'documentation-api';
const app = require('../src/app');
const { apiBaseUrl } = require('../src/config/env');
const limits = require('../src/services/token-rate-limit.service');
const specification = require('../docs/openapi.json');
let server, origin;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}${apiBaseUrl}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });
function allow(t) { t.mock.method(limits, 'checkDocumentationLimit', async () => 0); }

test('public specification preserves the existing document, configured server and conditional responses', async t => {
  allow(t);
  const response = await fetch(`${origin}/openapi.json`, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await response.json(), { ...specification, servers: [{ url: apiBaseUrl }] });
  const tag = response.headers.get('etag');
  assert.match(tag, /^"[^" ]+"$/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  const conditional = await new Promise((resolve, reject) => {
    http.get(`${origin}/openapi.json`, { headers: { 'If-None-Match': tag } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, tag: res.headers.etag }));
    }).on('error', reject);
  });
  assert.deepEqual(conditional, { status: 304, body: '', tag });
});

test('Swagger page loads local assets and initializes with the query-free specification URL', async t => {
  allow(t);
  for (const suffix of ['/docs', '/docs/']) {
    const response = await fetch(origin + suffix, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    const html = await response.text();
    const config = vm.runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], {
      window: {}, SwaggerUIBundle: Object.assign(options => options, { presets: { apis: 'apis' } }),
    });
    assert.equal(config.url, `${apiBaseUrl}/openapi.json`);
    assert.equal(config.queryConfigEnabled, false);
    assert.equal(config.validatorUrl, null);
    for (const url of [html.match(/href="([^"]+\.css)"/)[1], html.match(/src="([^"]+\.js)"/)[1]]) {
      const asset = await fetch(new URL(url, origin));
      assert.equal(asset.status, 200);
      assert.match(asset.headers.get('content-type'), /text\/css|application\/javascript/);
      assert.ok((await asset.text()).length > 1000);
    }
  }
});

test('documentation rejects unsupported, repeated and empty queries before the counter', async t => {
  t.mock.method(limits, 'checkDocumentationLimit', () => assert.fail('Invalid queries must not consume the budget'));
  for (const resource of ['/openapi.json', '/docs', '/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js']) {
    for (const query of ['?url=other', '?extra=', '?limit=1&limit=2']) {
      const response = await fetch(origin + resource + query, { headers: { 'If-None-Match': '*' } });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_QUERY');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('etag'), null);
    }
  }
});

test('specification, page and assets share the documentation limiter and fail closed', async t => {
  const resources = ['/openapi.json', '/docs', '/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js'];
  let calls = 0;
  const limiter = t.mock.method(limits, 'checkDocumentationLimit', async ip => { assert.equal(ip, '127.0.0.1'); calls++; return 17; });
  for (const resource of resources) {
    const response = await fetch(origin + resource, { headers: { 'If-None-Match': '*' } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('etag'), null);
    assert.deepEqual(await response.json(), { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many documentation requests. Try again later.', details: [] });
  }
  assert.equal(calls, resources.length);
  limiter.mock.mockImplementation(async () => { throw new Error('private database failure'); });
  for (const resource of ['/openapi.json', '/docs']) {
    const response = await fetch(origin + resource);
    assert.equal(response.status, 500);
    assert.equal((await response.json()).code, 'INTERNAL_SERVER_ERROR');
    assert.equal(response.headers.get('etag'), null);
  }
});

test('documentation uses the shared atomic counter with the documented 60/minute IP key', async t => {
  t.mock.method(limits.Counter, 'init', async () => {});
  const keys = [];
  let count = 0;
  t.mock.method(limits.Counter, 'findOneAndUpdate', (filter, pipeline, options) => {
    keys.push(filter._id);
    assert.match(filter._id, /^documentation-ip:[a-f0-9]{64}$/);
    assert.deepEqual(pipeline[0].$set.expiresAt.$cond[1], { $add: ['$$NOW', 60000] });
    assert.equal(options.upsert, true);
    assert.equal(options.updatePipeline, true);
    return { lean: async () => ({ count: ++count, expiresAt: new Date(Date.now() + 60000) }) };
  });
  for (let i = 0; i < 60; i++) assert.equal(await limits.checkDocumentationLimit('127.0.0.1'), 0);
  assert.ok(await limits.checkDocumentationLimit('127.0.0.1') > 0);
  assert.equal(new Set(keys).size, 1);
  await limits.checkDocumentationLimit('127.0.0.2');
  assert.notEqual(keys.at(-1), keys[0]);
});

test('existing OpenAPI is valid and lists exactly the implemented JSON operations', async () => {
  await SwaggerParser.validate(structuredClone(specification), { resolve: { external: false } });
  const routes = [
    ['health/health', '/health'], ['auth/user-tokens', '/auth/user-tokens'],
    ['auth/device-tokens', '/auth/device-tokens'], ['provinces/provinces', '/provinces'],
    ['districts/districts', ''], ['grid-substations/grid-substations', ''],
    ['readings/readings', ''], ['installations/installations', ''], ['district-summary/district-summary', ''],
  ];
  const actual = ['get /openapi.json'];
  for (const [feature, prefix] of routes) {
    for (const layer of require(`../src/features/${feature}.routes`).stack) {
      if (!layer.route) continue;
      const url = (prefix + (layer.route.path === '/' ? '' : layer.route.path)).replace(/:([\w]+)/g, '{$1}');
      for (const method of Object.keys(layer.route.methods)) actual.push(`${method} ${url}`);
    }
  }
  const documented = Object.entries(specification.paths).flatMap(([url, item]) =>
    Object.keys(item).filter(method => ['get', 'post', 'patch', 'delete', 'put'].includes(method)).map(method => `${method} ${url}`));
  assert.deepEqual(actual.sort(), documented.sort());
});

test('OpenAPI shares authentication, public responses and conditional-write contracts across operations', async () => {
  const spec = await SwaggerParser.dereference(structuredClone(specification), { resolve: { external: false } });
  for (const [url, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const publicOperation = url.startsWith('/auth/') || ['/health', '/openapi.json'].includes(url);
      const deviceWrite = method === 'post' && url.endsWith('/readings');
      assert.deepEqual(operation.security, publicOperation ? [] : [{ [deviceWrite ? 'InstallationBearer' : 'UserBearer']: [] }], `${method} ${url}`);
      const input = operation.requestBody?.content['application/json']?.schema;
      if (input) {
        assert.equal(input.additionalProperties, false);
        assert.deepEqual(Object.keys(input.properties).sort(), input.required.slice().sort());
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (['204', '304', '406'].includes(status)) assert.equal(response.content, undefined);
        if (status === '201') {
          for (const header of ['Location', 'ETag', 'Cache-Control']) assert.ok(response.headers[header]);
        }
        if (status === '429') assert.ok(response.headers['Retry-After']);
        if (Number(status) >= 400 && status !== '406') {
          assert.deepEqual(response.content['application/json'].schema, spec.components.schemas.Error);
        }
      }
    }
  }
  const installation = spec.paths['/installations/{installationId}'];
  for (const method of ['patch', 'delete']) {
    assert.equal(installation[method].parameters.find(parameter => parameter.name === 'If-Match').required, false);
    assert.ok(installation[method].responses['412']);
  }
  assert.ok(installation.delete.responses['409']);
  assert.equal(installation.delete.requestBody, undefined);
  const deleted = installation.delete.responses['204'];
  for (const header of ['ETag', 'Last-Modified']) assert.equal(deleted.headers[header], undefined);
  assert.equal(spec.components.schemas.InstallationInput.properties.deviceSecret.writeOnly, true);
  for (const schema of Object.values(spec.components.schemas)) {
    for (const field of ['_id', '__v', 'passwordHash', 'deviceCredentialHash']) {
      assert.equal(Object.hasOwn(schema.properties || {}, field), false);
    }
  }
});

test('documented query options match strict validators, including installation status', () => {
  const expected = {
    '/installations': ['offset', 'limit', 'provinceId', 'districtId', 'substationId', 'status'],
    '/readings': ['offset', 'limit', 'from', 'to', 'sort', 'provinceId', 'districtId', 'substationId'],
    '/installations/{installationId}/readings': ['offset', 'limit', 'from', 'to', 'sort'],
  };
  for (const [url, item] of Object.entries(specification.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const queries = (operation.parameters || []).filter(parameter => parameter.in === 'query');
      assert.deepEqual(queries.map(parameter => parameter.name).sort(), (method === 'get' ? expected[url] || [] : []).slice().sort());
      assert.ok(operation.responses['400']);
    }
  }
  const status = specification.paths['/installations'].get.parameters.find(parameter => parameter.name === 'status');
  assert.deepEqual(status.schema.enum, ['active', 'inactive']);
  assert.notEqual(status.required, true);
  const summary = specification.paths['/districts/{districtId}/generation-summary'].get;
  const district = summary.parameters.find(parameter => parameter.name === 'districtId');
  assert.equal(district.in, 'path');
  assert.equal(district.required, true);
  assert.equal(district.schema.format, 'uuid');
  const { validateInstallationQuery } = require('../src/features/readings/reading-query');
  for (const query of [{ status: 'active' }, { status: 'inactive' }, {}]) {
    let accepted = false;
    validateInstallationQuery({ query }, {}, () => { accepted = true; });
    assert.equal(accepted, true);
  }
  for (const query of [{ status: ['active', 'inactive'] }, { status: '' }, { status: 'Active' }, { extra: '' }]) {
    const res = { status(value) { assert.equal(value, 400); return this; }, json(body) { assert.equal(body.code, 'INVALID_QUERY'); } };
    validateInstallationQuery({ query }, res, () => assert.fail('Unsupported query accepted'));
  }
});
