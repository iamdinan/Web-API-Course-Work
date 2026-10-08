const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "device-token-test-key-with-at-least-32-bytes";
process.env.JWT_ISSUER = "test-issuer";
process.env.JWT_AUDIENCE = "test-audience";
process.env.JWT_EXPIRES_IN_SECONDS = "600";
const app = require("../src/app");
const { apiBaseUrl } = require("../src/config/env");
const config = require("../src/config/jwt");
const { SolarInstallation, User } = require("../src/models");
const { hashPassword } = require("../src/services/passwords");
const limits = require("../src/services/token-rate-limit.service");
// Deliberately independent of the development prefix: login verifies stored hashes.
const meterId = "METER-01-03", deviceSecret = " independent device secret ";
let server, origin, hash;

before(async () => {
  hash = await hashPassword(deviceSecret);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}${apiBaseUrl}`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function mockLogin(t, installation) {
  let queries = 0;
  t.mock.method(SolarInstallation, "findOne", filter => {
    queries++;
    assert.deepEqual(filter, { meterId });
    return { select(fields) { assert.equal(fields, "publicId status +deviceCredentialHash"); return this; }, lean: async () => installation };
  });
  t.mock.method(limits, "checkDeviceTokenLimit", async (ip, id) => {
    assert.ok(ip);
    assert.equal(id, meterId);
    return 0;
  });
  return () => queries;
}
function post(body = { meterId, deviceSecret }, headers = {}) {
  return fetch(`${origin}/auth/device-tokens`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

function noStore(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
}

test("device login signs only installation claims and the issued token cannot read provinces", async t => {
  const installation = { publicId: randomUUID(), status: "active", deviceCredentialHash: hash, _id: "internal" };
  mockLogin(t, installation);
  const snapshot = JSON.stringify(installation);
  const response = await post();
  assert.equal(response.status, 200);
  noStore(response);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "expires_in", "installationId", "token_type"]);
  assert.equal(body.installationId, installation.publicId);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 600);
  const claims = jwt.verify(body.access_token, config.signingKey, { algorithms: [config.algorithm], issuer: config.issuer, audience: config.audience });
  assert.deepEqual(Object.keys(claims).sort(), ["actor", "aud", "exp", "iat", "iss", "scope", "sub"]);
  assert.equal(claims.sub, installation.publicId);
  assert.equal(body.installationId, claims.sub);
  assert.equal(claims.actor, "installation");
  assert.equal(claims.scope, "installation-write");
  assert.equal(claims.exp - claims.iat, 600);
  assert.equal(JSON.stringify(installation), snapshot);
  let userLookups = 0;
  t.mock.method(User, "findOne", () => { userLookups++; throw new Error("Must reject before user lookup"); });
  const denied = await fetch(`${origin}/provinces`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { code: "UNAUTHORIZED", message: "A valid user bearer token is required.", details: [] });
  assert.equal(userLookups, 0);
});

test("unknown meters, wrong secrets, malformed hashes and inactive wrong secrets share generic 401", async t => {
  mockLogin(t, null);
  let current;
  SolarInstallation.findOne.mock.mockImplementation(() => ({ select() { return this; }, lean: async () => current }));
  for (const installation of [null, { status: "active", deviceCredentialHash: hash },
    { status: "active", deviceCredentialHash: "malformed" }, { status: "inactive", deviceCredentialHash: hash }]) {
    current = installation;
    const response = await post({ meterId, deviceSecret: deviceSecret.trim() });
    assert.equal(response.status, 401);
    noStore(response);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { code: "INVALID_CREDENTIALS", message: "Invalid meter ID or device secret.", details: [] });
  }
});

test("inactive installations return 403 only after correct credential verification", async t => {
  mockLogin(t, { publicId: randomUUID(), status: "inactive", deviceCredentialHash: hash });
  const response = await post();
  assert.equal(response.status, 403);
  noStore(response);
  assert.deepEqual(await response.json(), { code: "INSTALLATION_INACTIVE", message: "Inactive installations cannot obtain device tokens.", details: [] });
});

test("invalid device login shapes and parser/media errors fail before lookup and limits", async t => {
  const queries = mockLogin(t, null);
  let attempts = 0;
  limits.checkDeviceTokenLimit.mock.mockImplementation(async () => { attempts++; return 0; });
  for (const body of [null, [], {}, { meterId }, { deviceSecret }, { meterId: "", deviceSecret },
    { meterId: " ", deviceSecret }, { meterId, deviceSecret: " " }, { meterId: 123, deviceSecret },
    { meterId: { $ne: null }, deviceSecret }, { meterId, deviceSecret: [] }, { meterId, deviceSecret, scope: "admin" }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    noStore(response);
    assert.ok(["INVALID_REQUEST", "INVALID_JSON"].includes((await response.json()).code));
  }
  for (const [headers, body, status, code] of [
    [{ "Content-Type": "application/json" }, "{", 400, "INVALID_JSON"],
    [{ "Content-Type": "text/plain" }, "text", 415, "UNSUPPORTED_MEDIA_TYPE"],
    [{ "Content-Type": "application/json" }, JSON.stringify({ meterId, deviceSecret: "x".repeat(110000) }), 413, "PAYLOAD_TOO_LARGE"],
  ]) {
    const response = await fetch(`${origin}/auth/device-tokens`, { method: "POST", headers, body });
    assert.equal(response.status, status);
    noStore(response);
    assert.equal((await response.json()).code, code);
  }
  const unacceptable = await post(undefined, { Accept: "text/html" });
  assert.equal(unacceptable.status, 406);
  noStore(unacceptable);
  assert.equal(await unacceptable.text(), "");
  assert.equal(queries(), 0);
  assert.equal(attempts, 0);
});

test("device limits and persistence failures return sanitized errors without tokens", async t => {
  const queries = mockLogin(t, null);
  limits.checkDeviceTokenLimit.mock.mockImplementation(async () => 42);
  const response = await post();
  assert.equal(response.status, 429);
  noStore(response);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal((await response.json()).code, "RATE_LIMIT_EXCEEDED");
  assert.equal(queries(), 0);
  limits.checkDeviceTokenLimit.mock.mockImplementation(async () => { throw new Error("Private persistence diagnostics"); });
  const failed = await post();
  assert.equal(failed.status, 500);
  noStore(failed);
  assert.deepEqual(await failed.json(), { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  limits.checkDeviceTokenLimit.mock.mockImplementation(async () => 0);
  SolarInstallation.findOne.mock.mockImplementation(() => { throw new Error("Private persistence diagnostics"); });
  const unavailable = await post();
  assert.equal(unavailable.status, 500);
  assert.equal((await unavailable.json()).code, "INTERNAL_SERVER_ERROR");
});

test("device token counters use shared atomic IP and meter windows with five allowed attempts", async t => {
  const keys = [];
  const digest = value => createHash("sha256").update(value).digest("hex");
  t.mock.method(limits.Counter, "init", async () => {});
  let count = 5;
  t.mock.method(limits.Counter, "findOneAndUpdate", (filter, pipeline, options) => {
    keys.push(filter._id);
    assert.equal(options.upsert, true);
    assert.equal(options.updatePipeline, true);
    assert.equal(pipeline[0].$set.expiresAt.$cond[1].$add[1], 15 * 60 * 1000);
    return { lean: async () => ({ count, expiresAt: new Date(Date.now() + 900000) }) };
  });
  assert.equal(await limits.checkDeviceTokenLimit("127.0.0.1", meterId), 0);
  assert.deepEqual(keys, [`device-token-ip:${digest("127.0.0.1")}`, `device-token-meter:${digest(meterId)}`]);
  count = 6;
  assert.ok(await limits.checkDeviceTokenLimit("127.0.0.1", meterId) > 0);
  assert.equal(keys.length, 3); // Exceeded IP window short-circuits the meter counter.
});

test("OpenAPI documents the implemented device exchange and errors", async () => {
  const spec = await (await fetch(`${origin}/openapi.json`)).json();
  const operation = spec.paths["/auth/device-tokens"].post;
  assert.deepEqual(operation.security, []);
  const schema = operation.requestBody.content["application/json"].schema;
  assert.deepEqual(schema.required, ["meterId", "deviceSecret"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.deviceSecret.writeOnly, true);
  assert.equal(operation.responses[200].$ref, "#/components/responses/DeviceTokenIssued");
  assert.equal(spec.components.schemas.DeviceAccessToken.additionalProperties, false);
  assert.ok(spec.components.schemas.DeviceAccessToken.required.includes("installationId"));
  for (const status of ["200", "400", "401", "403", "406", "413", "415", "429", "500"]) assert.ok(operation.responses[status]);
  assert.deepEqual(spec.paths["/installations/{installationId}/readings"].get.security, [{ UserBearer: [] }]);
});
