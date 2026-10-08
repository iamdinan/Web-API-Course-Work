const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "query-rejection-test-key-at-least-32-bytes";
process.env.JWT_ISSUER = "query-tests";
process.env.JWT_AUDIENCE = "query-api";
const config = require("../src/config/jwt");
const { apiBaseUrl } = require("../src/config/env");
const app = require("../src/app");
const models = require("../src/models");
const limits = require("../src/services/token-rate-limit.service");
let server, origin;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}${apiBaseUrl}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function fixtures(t) {
  const userId = randomUUID(), installationId = randomUUID(), substationId = randomUUID();
  const user = { publicId: userId, role: "admin", readScope: "national" };
  const sign = (id, claims) => jwt.sign(claims, config.signingKey, {
    algorithm: config.algorithm, subject: id, issuer: config.issuer, audience: config.audience, expiresIn: 900,
  });
  const userToken = sign(userId, { actor: "user" });
  const deviceToken = sign(installationId, { actor: "installation", scope: "installation-write" });
  const query = value => ({ select() { return this; }, lean: async () => value });
  t.mock.method(models.User, "findOne", () => query(user));
  t.mock.method(models.SolarInstallation, "findOne", () => query({ publicId: installationId, status: "active" }));
  let reads = 0;
  t.mock.method(limits, "checkUserReadLimit", async () => { reads++; return 0; });
  for (const name of ["checkUserTokenLimit", "checkDeviceTokenLimit", "checkDeviceWriteLimit", "checkAdminWriteLimit"]) {
    t.mock.method(limits, name, () => { assert.fail(`${name} must not run for invalid queries`); });
  }
  return { user, userToken, deviceToken, installationId, substationId, reads: () => reads };
}

function endpoints(f) {
  return [
    ["GET", "/health"], ["GET", "/openapi.json"],
    ["POST", "/auth/user-tokens", null, { email: "query@example.com", password: "test-secret" }],
    ["POST", "/auth/device-tokens", null, { meterId: "METER-TEST", deviceSecret: "test-secret" }],
    ...[`/grid-substations/${f.substationId}`, `/installations/${f.installationId}`,
      `/installations/${f.installationId}/overview`, `/installations/${f.installationId}/last-reading`,
      `/installations/${f.installationId}/readings/${randomUUID()}`].map(path => ["GET", path, f.userToken]),
    ["POST", "/installations", f.userToken, { substationId: f.substationId, meterId: "METER-TEST", deviceSecret: "test-secret" }],
    ["PATCH", `/installations/${f.installationId}`, f.userToken, { status: "inactive" }],
    ["DELETE", `/installations/${f.installationId}`, f.userToken],
    ["POST", `/installations/${f.installationId}/readings`, f.deviceToken,
      { recordedAt: "2026-10-08T12:00:00+05:30", powerKw: 3, energyKwh: 40, voltageV: 230 }],
  ];
}
function request([method, path, token, body], suffix = "", headers = {}) {
  return fetch(origin + path + suffix, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}), ...headers,
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("formerly ignored queries are rejected across public, login, read and write endpoints", async t => {
  const f = fixtures(t);
  for (const endpoint of endpoints(f)) {
    for (const suffix of ["?status=inactive", "?limit=1&limit=2", "?extra="]) {
      const response = await request(endpoint, suffix, { "If-None-Match": "*", "If-Match": '"stale"' });
      assert.equal(response.status, 400, `${endpoint[0]} ${endpoint[1]}${suffix}`);
      assert.deepEqual(await response.json(), { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), null);
      assert.equal(response.headers.get("last-modified"), null);
    }
  }
  assert.equal(f.reads(), 15); // Five protected reads, three query shapes each.
});

test("query rejection preserves authentication, admin/ownership checks and read limits", async t => {
  const f = fixtures(t);
  const url = `/installations/${f.installationId}`;
  const unauthorized = await request(["GET", url], "?extra=1");
  assert.equal(unauthorized.status, 401); await unauthorized.text();
  f.user.role = "user";
  const forbidden = await request(["PATCH", url, f.userToken, { status: "inactive" }], "?extra=1");
  assert.equal(forbidden.status, 403); await forbidden.text();
  const wrongOwner = await request(["POST", `/installations/${randomUUID()}/readings`, f.deviceToken], "?extra=1");
  assert.equal(wrongOwner.status, 403); await wrongOwner.text();
  t.mock.method(limits, "checkUserReadLimit", async () => 12);
  const limited = await request(["GET", url, f.userToken], "?extra=1");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "12"); await limited.text();
});

test("public endpoints still work without queries and OpenAPI documents the new 400 responses", async () => {
  const health = await request(["GET", "/health"]);
  assert.equal(health.status, 200); assert.deepEqual(await health.json(), { status: "ok" });
  const response = await request(["GET", "/openapi.json"]);
  assert.equal(response.status, 200);
  const spec = await response.json();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (operation.parameters?.some(parameter => parameter.in === "query")) continue;
      assert.ok(operation.responses[400], `${method} ${path} needs a query error response`);
      assert.match(operation.description, /query parameters/i);
    }
  }
});
