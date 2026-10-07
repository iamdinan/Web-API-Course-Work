const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "installation-verification-key-at-least-32-bytes";
process.env.JWT_ISSUER = "installation-tests";
process.env.JWT_AUDIENCE = "test-api";
process.env.JWT_EXPIRES_IN_SECONDS = "900";
const config = require("../src/config/jwt");
const { SolarInstallation, User } = require("../src/models");
const { signAccessToken } = require("../src/services/access-tokens");
const { verifyInstallationJwt } = require("../src/middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../src/middleware/require-installation-ownership");
const { verifyUserJwt } = require("../src/middleware/verify-user-jwt");
const { errorHandler } = require("../src/middleware/error-handler");

function token(id, claims = {}, options = {}) {
  return jwt.sign({ actor: "installation", scope: "installation-write", ...claims }, config.signingKey,
    { algorithm: config.algorithm, subject: id, issuer: config.issuer, audience: config.audience, expiresIn: 900, ...options });
}
function response() {
  return {
    headers: {}, statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}
async function verify(authorization, middleware = verifyInstallationJwt, extra = {}) {
  const req = { headers: { authorization }, ...extra };
  const res = response();
  let nextCalls = 0;
  await middleware(req, res, () => { nextCalls++; });
  return { req, res, nextCalls };
}
function assertUnauthorized(result) {
  assert.equal(result.res.statusCode, 401);
  assert.equal(result.res.headers["WWW-Authenticate"], "Bearer");
  assert.deepEqual(result.res.body, { code: "UNAUTHORIZED", message: "A valid installation bearer token is required.", details: [] });
  assert.equal(result.nextCalls, 0);
  assert.equal(result.req.installation, undefined);
}
function mockInstallation(t, id, installation) {
  const state = { installation, lookups: 0 };
  t.mock.method(SolarInstallation, "findOne", filter => {
    state.lookups++;
    assert.deepEqual(filter, { publicId: id });
    return { select(fields) { assert.equal(fields, "publicId status"); return this; }, lean: async () => state.installation };
  });
  return state;
}

test("invalid installation bearer tokens and wrong actors return 401 before persistence", async t => {
  const id = randomUUID();
  const state = mockInstallation(t, id, null);
  const headers = [undefined, "", "Basic abc", "Bearer", "Bearer garbage", `Bearer ${token(id)},extra`,
    `Bearer ${token(id)} ${token(id)}`, `Bearer ${token(id, {}, { expiresIn: -1 })}`,
    `Bearer ${token(id, {}, { issuer: "foreign" })}`, `Bearer ${token(id, {}, { audience: "foreign" })}`,
    `Bearer ${token(id, {}, { algorithm: "HS384" })}`, `Bearer ${token(id, {}, { notBefore: 60 })}`,
    `Bearer ${token("invalid-id")}`, `Bearer ${token(id, {}, { expiresIn: 3601 })}`,
    `Bearer ${token(id, {}, { noTimestamp: true })}`,
    `Bearer ${token(id, { actor: "user", role: "admin", readScope: "national" })}`,
    `Bearer ${token(id, { actor: null })}`, `Bearer ${token(id, { actor: "device" })}`,
    `Bearer ${jwt.sign({ sub: id, actor: "installation", scope: "installation-write" }, config.signingKey, { issuer: config.issuer, audience: config.audience })}`,
    `Bearer ${jwt.sign({ sub: id, actor: "installation", scope: "installation-write" }, "wrong-signing-key-with-32-bytes", { issuer: config.issuer, audience: config.audience, expiresIn: 900 })}`,
    `Bearer ${jwt.sign({ sub: id, actor: "installation", scope: "installation-write" }, "", { algorithm: "none", expiresIn: 900 })}`,
  ];
  for (const header of headers) assertUnauthorized(await verify(header));
  assert.equal(state.lookups, 0);
});

test("installation actors without exact installation-write scope return 403 before persistence", async t => {
  const id = randomUUID();
  const state = mockInstallation(t, id, null);
  for (const scope of [undefined, null, "", "user-read", ["installation-write"], "installation-write other", " installation-write "]) {
    const result = await verify(`Bearer ${token(id, { scope })}`);
    assert.equal(result.res.statusCode, 403);
    assert.deepEqual(result.res.body, { code: "FORBIDDEN", message: "The token does not permit installation writes.", details: [] });
    assert.equal(result.nextCalls, 0);
    assert.equal(result.req.installation, undefined);
  }
  assert.equal(state.lookups, 0);
});

test("active installation verification uses current MongoDB identity and attaches only a frozen public ID", async t => {
  const id = randomUUID();
  const stored = { publicId: id, status: "active", meterId: "METER-01-03", substationId: randomUUID(),
    _id: "internal", deviceCredentialHash: "private-hash" };
  const state = mockInstallation(t, id, stored);
  const snapshot = JSON.stringify(stored);
  const signed = signAccessToken(id, { actor: "installation", scope: "installation-write",
    status: "inactive", meterId: "forged-meter", role: "admin", installationId: randomUUID() }).access_token;
  const result = await verify(`bEaReR ${signed}`);
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(result.req.installation, { id });
  assert.equal(Object.isFrozen(result.req.installation), true);
  assert.equal(result.req.user, undefined);
  assert.equal(result.res.body, undefined);
  assert.equal(JSON.stringify(stored), snapshot);
  assert.equal(state.lookups, 1);
});

test("the same unexpired token fails after deactivation or deletion and cannot bind to a replacement", async t => {
  const id = randomUUID();
  const state = mockInstallation(t, id, { publicId: id, status: "active" });
  const header = `Bearer ${token(id, { status: "active" })}`;
  assert.equal((await verify(header)).nextCalls, 1);
  state.installation.status = "inactive";
  const inactive = await verify(header);
  assert.equal(inactive.res.statusCode, 403);
  assert.deepEqual(inactive.res.body, { code: "INSTALLATION_INACTIVE", message: "Inactive installations cannot authenticate for writes.", details: [] });
  assert.equal(inactive.req.installation, undefined);
  assert.equal(inactive.nextCalls, 0);
  state.installation = null;
  assertUnauthorized(await verify(header));
  state.installation = { publicId: randomUUID(), status: "active" };
  assertUnauthorized(await verify(header));
  state.installation = { publicId: id, status: "unknown" };
  assertUnauthorized(await verify(header));
});

test("ownership middleware allows only the authenticated installation URL ID", async t => {
  const id = randomUUID();
  mockInstallation(t, id, { publicId: id, status: "active" });
  const verified = await verify(`Bearer ${token(id)}`);
  for (const installationId of [id, randomUUID(), undefined, "invalid-id"]) {
    const res = response();
    let nextCalls = 0;
    requireInstallationOwnership({ ...verified.req, params: { installationId } }, res, () => { nextCalls++; });
    if (installationId === id) {
      assert.equal(nextCalls, 1);
      assert.equal(res.body, undefined);
    } else {
      assert.equal(nextCalls, 0);
      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.body, { code: "FORBIDDEN", message: "The authenticated installation cannot access this installation.", details: [] });
    }
  }
  const missing = await verify(undefined, requireInstallationOwnership, { params: { installationId: id }, user: { id, role: "admin" } });
  assertUnauthorized(missing);
});

test("user verification remains separate from installation verification and both actors fail on the other middleware", async t => {
  const id = randomUUID();
  let userLookups = 0;
  t.mock.method(User, "findOne", filter => {
    userLookups++;
    assert.deepEqual(filter, { publicId: id });
    return { select() { return this; }, lean: async () => ({ publicId: id, role: "user", readScope: "national" }) };
  });
  const state = mockInstallation(t, id, { publicId: id, status: "active" });
  const userToken = signAccessToken(id, { actor: "user", role: "user", readScope: "national" }).access_token;
  const installationToken = signAccessToken(id, { actor: "installation", scope: "installation-write" }).access_token;
  assertUnauthorized(await verify(`Bearer ${userToken}`));
  const rejected = await verify(`Bearer ${installationToken}`, verifyUserJwt);
  assert.equal(rejected.res.statusCode, 401);
  assert.equal(rejected.req.user, undefined);
  assert.equal(userLookups, 0);
  assert.equal(state.lookups, 0);
  const accepted = await verify(`Bearer ${userToken}`, verifyUserJwt);
  assert.equal(accepted.nextCalls, 1);
  assert.deepEqual(accepted.req.user, { id, role: "user", readScope: "national" });
  assert.equal(accepted.req.installation, undefined);
});

test("installation database failures propagate into the existing sanitized 500 handler", async t => {
  t.mock.method(SolarInstallation, "findOne", () => { throw new Error("Private persistence diagnostics"); });
  let failure;
  try { await verify(`Bearer ${token(randomUUID())}`); } catch (error) { failure = error; }
  assert.ok(failure);
  const res = response();
  errorHandler(failure, {}, res, () => { throw new Error("Unexpected next"); });
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
});
