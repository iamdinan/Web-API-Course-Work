const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "user-token-test-key-with-at-least-32-bytes";
process.env.JWT_ISSUER = "test-issuer";
process.env.JWT_AUDIENCE = "test-audience";
process.env.JWT_EXPIRES_IN_SECONDS = "900";
const app = require("../src/app");
const { apiBaseUrl } = require("../src/config/env");
const config = require("../src/config/jwt");
const { User } = require("../src/models");
const limits = require("../src/services/token-rate-limit.service");
const { verifyPassword } = require("../src/services/passwords");
const password = "test password with spaces ";
let origin, server, hash;

before(async () => {
  require('node:test').mock.method(limits, 'checkDocumentationLimit', async () => 0);
  const salt = "a".repeat(32);
  hash = `scrypt$${salt}$${(await promisify(scrypt)(password, salt, 64)).toString("hex")}`;
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}${apiBaseUrl}/auth/user-tokens`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function mockLogin(t, user) {
  let queries = 0;
  t.mock.method(User, "findOne", filter => {
    queries++;
    assert.deepEqual(filter, { email: "analyst@example.com" });
    return { select(fields) { assert.ok(fields.includes("+passwordHash")); return this; }, lean: async () => user };
  });
  t.mock.method(limits, "checkUserTokenLimit", async () => 0);
  return () => queries;
}

function post(body, headers = {}) {
  return fetch(origin, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("admin/national/province/district logins issue verifiable short-lived database-derived claims", async t => {
  const profiles = [
    { role: "admin", readScope: "national" }, { role: "user", readScope: "national" },
    { role: "user", readScope: "province", provinceId: randomUUID() },
    { role: "user", readScope: "district", districtId: randomUUID() },
  ];
  let current;
  mockLogin(t, null);
  t.mock.method(User, "findOne", filter => {
    assert.deepEqual(filter, { email: "analyst@example.com" });
    return { select() { return this; }, lean: async () => current };
  });
  for (const profile of profiles) {
    current = { publicId: randomUUID(), _id: "internal", email: "analyst@example.com", passwordHash: hash, ...profile };
    const response = await post({ email: " ANALYST@EXAMPLE.COM ", password });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["access_token", "expires_in", "token_type", "userId"]);
    assert.equal(body.userId, current.publicId);
    assert.equal(body.expires_in, 900);
    assert.equal(body.token_type, "Bearer");
    const claims = jwt.verify(body.access_token, config.signingKey, { algorithms: ["HS256"], issuer: config.issuer, audience: config.audience });
    assert.equal(claims.actor, "user");
    assert.equal(claims.sub, current.publicId);
    assert.equal(body.userId, claims.sub);
    for (const key of ["role", "readScope", "provinceId", "districtId"]) assert.equal(claims[key], current[key]);
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal(Object.hasOwn(claims, "passwordHash"), false);
    assert.equal(Object.hasOwn(claims, "password"), false);
    assert.equal(Object.hasOwn(claims, "_id"), false);
    assert.equal(Object.hasOwn(claims, "email"), false);
    if (profile.role === "admin") assert.deepEqual(claims.permissions, ["installation-create", "installation-status-update", "installation-delete"]);
    else assert.equal(claims.permissions, undefined);
    assert.throws(() => jwt.verify(body.access_token, "wrong-key"));
    assert.throws(() => jwt.verify(body.access_token, config.signingKey, { audience: "wrong-audience" }));
    assert.throws(() => jwt.verify(body.access_token, config.signingKey, { issuer: "wrong-issuer" }));
    assert.throws(() => jwt.verify(body.access_token, config.signingKey, { clockTimestamp: claims.exp }));
  }
});

test("wrong passwords, absent users, and invalid stored hashes return the same credential error", async t => {
  mockLogin(t, null);
  let user;
  t.mock.method(User, "findOne", () => ({ select() { return this; }, lean: async () => user }));
  let previous;
  for (const value of [null, { passwordHash: hash }, { passwordHash: "malformed" }]) {
    user = value;
    const response = await post({ email: "analyst@example.com", password: "wrong password" });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    const body = await response.json();
    assert.deepEqual(body, { code: "INVALID_CREDENTIALS", message: "Invalid email or password.", details: [] });
    if (previous) assert.deepEqual(body, previous);
    previous = body;
  }
  assert.equal(await verifyPassword(password.trim(), hash), false);
});

test("malformed, missing, wrong-type, injected and extra request fields are rejected before lookup", async t => {
  const queries = mockLogin(t, null);
  for (const body of [null, [], {}, { email: "analyst@example.com" },
    { email: "invalid", password }, { email: { $ne: null }, password },
    { email: "analyst@example.com", password: 123 }, { email: "analyst@example.com", password: " " },
    { email: "analyst@example.com", password, role: "admin" },
    { email: "analyst@example.com", password, provinceId: randomUUID() }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.ok(["INVALID_REQUEST", "INVALID_JSON"].includes(error.code));
    assert.deepEqual(error.details, []);
  }
  const invalid = await fetch(origin, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "INVALID_JSON");
  const wrongType = await fetch(origin, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "text" });
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  const oversized = await post({ email: "analyst@example.com", password: "x".repeat(110000) });
  assert.equal(oversized.status, 413);
  await oversized.text();
  const unacceptable = await post({ email: "analyst@example.com", password }, { Accept: "text/html" });
  assert.equal(unacceptable.status, 406);
  assert.equal(await unacceptable.text(), "");
  assert.equal(queries(), 0);
});

test("rate limits and database failures use sanitized errors without issuing a token", async t => {
  const queries = mockLogin(t, null);
  t.mock.method(limits, "checkUserTokenLimit", async () => 42);
  const limited = await post({ email: "analyst@example.com", password });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "42");
  assert.equal((await limited.json()).code, "RATE_LIMIT_EXCEEDED");
  assert.equal(queries(), 0);
  t.mock.method(limits, "checkUserTokenLimit", async () => { throw new Error("private hash and password"); });
  const failed = await post({ email: "analyst@example.com", password });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  t.mock.method(limits, "checkUserTokenLimit", async () => 0);
  t.mock.method(User, "findOne", () => ({ select() { return this; }, lean: async () => { throw new Error("private database error"); } }));
  const unavailable = await post({ email: "analyst@example.com", password });
  assert.equal(unavailable.status, 500);
  assert.equal((await unavailable.json()).code, "INTERNAL_SERVER_ERROR");
});

test("OpenAPI exposes only the implemented user-token exchange with request/error contracts", async () => {
  const response = await fetch(origin.replace(/\/auth\/user-tokens$/, "/openapi.json"));
  const spec = await response.json();
  const operation = spec.paths["/auth/user-tokens"].post;
  assert.deepEqual(operation.security, []);
  assert.deepEqual(operation.requestBody.content["application/json"].schema.required, ["email", "password"]);
  assert.equal(operation.requestBody.content["application/json"].schema.additionalProperties, false);
  assert.equal(operation.responses[200].$ref, "#/components/responses/UserTokenIssued");
  assert.equal(spec.components.schemas.UserAccessToken.additionalProperties, false);
  assert.ok(spec.components.schemas.UserAccessToken.required.includes("userId"));
  for (const status of ["200", "400", "401", "406", "413", "415", "429", "500"]) assert.ok(operation.responses[status]);
  assert.ok(spec.paths["/auth/device-tokens"].post);
});

test("JWT configuration rejects missing/weak keys, missing issuer/audience, and invalid lifetimes", () => {
  for (const override of [{ JWT_SIGNING_KEY: "" }, { JWT_SIGNING_KEY: "short" }, { JWT_ISSUER: "" },
    { JWT_AUDIENCE: "" }, { JWT_EXPIRES_IN_SECONDS: "invalid" }, { JWT_EXPIRES_IN_SECONDS: "3601" }]) {
    const result = spawnSync(process.execPath, ["-e", "require('./src/config/jwt')"], { env: { ...process.env, ...override }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JWT_SIGNING_KEY must|JWT_ISSUER and JWT_AUDIENCE|JWT_EXPIRES_IN_SECONDS must/);
  }
});
