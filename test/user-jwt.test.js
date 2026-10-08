const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const http = require("node:http");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "user-verification-test-key-at-least-32-bytes";
process.env.JWT_ISSUER = "verification-tests";
process.env.JWT_AUDIENCE = "test-users";
const config = require("../src/config/jwt");
const app = require("../src/app");
const { apiBaseUrl } = require("../src/config/env");
const models = require("../src/models");
const mongoose = require("mongoose");
const limits = require("../src/services/token-rate-limit.service");
const { verifyUserJwt } = require("../src/middleware/verify-user-jwt");
let origin, server;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}${apiBaseUrl}/provinces`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); });

function token(id, claims = {}, options = {}) {
  return jwt.sign({ actor: "user", role: "admin", readScope: "national", ...claims }, config.signingKey,
    { algorithm: "HS256", subject: id, issuer: config.issuer, audience: config.audience, expiresIn: 900, ...options });
}

function fixtures(t) {
  t.mock.method(mongoose.connection, "transaction", async (callback, options) => {
    assert.deepEqual(options, { readConcern: { level: "snapshot" } });
    return callback(null);
  });
  const provinces = ["Alpha", "Beta", "Gamma"].map(name => ({ publicId: randomUUID(), name, _id: "internal" }));
  const districts = [0, 0, 1].map((index, number) => ({ publicId: randomUUID(), provinceId: provinces[index].publicId, name: `District ${number}` }));
  const substations = districts.map(district => ({ publicId: randomUUID(), districtId: district.publicId }));
  const state = { user: { publicId: randomUUID(), role: "user", readScope: "national", passwordHash: "private-hash" }, lookups: 0 };
  function matches(record, filter) {
    return Object.entries(filter).every(([key, value]) => value && typeof value === "object" && "$in" in value
      ? value.$in.includes(record[key]) : record[key] === value);
  }
  function query(records) {
    return {
      offset: 0, max: Infinity,
      select() { return this; },
      session() { return this; },
      sort() { records.sort((a, b) => a.name.localeCompare(b.name) || a.publicId.localeCompare(b.publicId)); return this; },
      skip(offset) { this.offset = offset; return this; }, limit(max) { this.max = max; return this; },
      lean() { return Promise.resolve(records.slice(this.offset, this.offset + this.max)); },
    };
  }
  t.mock.method(models.User, "findOne", filter => {
    state.lookups++;
    assert.deepEqual(filter, { publicId: state.subject || state.user?.publicId });
    return { select(fields) { assert.equal(fields.includes("passwordHash"), false); return this; }, lean: async () => state.user };
  });
  for (const [Model, records] of [[models.Province, provinces], [models.District, districts], [models.GridSubstation, substations]]) {
    t.mock.method(Model, "findOne", filter => ({ select() { return this; }, session() { return this; }, lean: async () => records.find(record => matches(record, filter)) || null }));
    t.mock.method(Model, "find", filter => query(records.filter(record => matches(record, filter))));
    t.mock.method(Model, "countDocuments", async filter => records.filter(record => matches(record, filter)).length);
  }
  t.mock.method(limits, "checkUserReadLimit", async id => { assert.equal(id, state.user.publicId); return 0; });
  return { state, provinces, districts, substations };
}

function get(accessToken, query = "", headers = {}) {
  return fetch(origin + query, { headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...headers } });
}

test("missing, malformed, invalid, expired, foreign and non-user JWTs are rejected before database reads", async t => {
  const { state } = fixtures(t);
  const id = state.user.publicId;
  const invalidTokens = [null, "not-a-jwt", token(id, {}, { expiresIn: -1 }), token(id, {}, { issuer: "foreign" }),
    token(id, {}, { audience: "foreign" }), token(id, { actor: "installation" }), token("invalid-id"),
    token(id, {}, { algorithm: "HS384" }), token(id, {}, { notBefore: 60 }),
    jwt.sign({ actor: "user", sub: id }, config.signingKey, { issuer: config.issuer, audience: config.audience }),
    jwt.sign({ actor: "user", sub: id }, "a-different-key-at-least-32-bytes", { issuer: config.issuer, audience: config.audience, expiresIn: 900 })];
  for (const accessToken of invalidTokens) {
    const response = await get(accessToken);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assert.deepEqual(await response.json(), { code: "UNAUTHORIZED", message: "A valid user bearer token is required.", details: [] });
  }
  for (const authorization of ["Basic abc", "Bearer", `Bearer ${token(id)},extra`]) {
    const response = await get(null, "", { Authorization: authorization });
    assert.equal(response.status, 401);
    await response.text();
  }
  assert.equal(state.lookups, 0);
});

test("verification attaches only current stored identity/access and rejects removed or invalid users", async t => {
  const { state, provinces } = fixtures(t);
  state.user = { ...state.user, role: "user", readScope: "province", provinceId: provinces[0].publicId };
  const id = state.user.publicId;
  const req = { headers: { authorization: `bearer ${token(id, { permissions: ["installation-delete"] })}` } };
  await verifyUserJwt(req, {}, () => {});
  assert.deepEqual(req.user, { id, role: "user", readScope: "province", provinceId: provinces[0].publicId });
  assert.equal(req.user.permissions, undefined);
  assert.equal(req.user.passwordHash, undefined);
  state.subject = id;
  state.user = null;
  const deleted = await get(token(id));
  assert.equal(deleted.status, 401);
  await deleted.text();
  state.user = { publicId: id, role: "admin", readScope: "province", provinceId: provinces[0].publicId };
  const invalid = await get(token(id));
  assert.equal(invalid.status, 401);
  await invalid.text();
});

test("complete province lists and counts use current national/admin/provincial/district assignments", async t => {
  const { state, provinces, districts } = fixtures(t);
  const accessToken = token(state.user.publicId);
  for (const role of ["user", "admin"]) {
    state.user.role = role;
    const body = await (await get(accessToken)).json();
    assert.equal(body.count, 3);
    assert.deepEqual(Object.keys(body), ["count", "items"]);
    assert.equal(body.count, body.items.length);
    assert.deepEqual(body.items.map(item => item.id), provinces.map(province => province.publicId));
    assert.deepEqual(Object.keys(body.items[0]).sort(), ["id", "name"]);
  }
  state.user = { ...state.user, role: "user", readScope: "province", provinceId: provinces[0].publicId };
  const provincial = await (await get(accessToken)).json();
  assert.equal(provincial.count, 1);
  assert.equal(provincial.items[0].id, provinces[0].publicId);
  delete state.user.provinceId;
  state.user.readScope = "district";
  state.user.districtId = districts[0].publicId;
  const district = await (await get(accessToken)).json();
  assert.equal(district.count, 1);
  assert.equal(district.items[0].id, provinces[0].publicId);
  // The same unexpired token must immediately reflect a new stored scope.
  delete state.user.districtId;
  state.user.readScope = "national";
  assert.equal((await (await get(accessToken)).json()).count, 3);
  state.user.readScope = "district";
  state.user.districtId = districts[0].publicId;
  delete districts[0].provinceId;
  assert.equal((await (await get(accessToken)).json()).count, 0);
  state.user.districtId = randomUUID();
  assert.equal((await (await get(accessToken)).json()).count, 0);
  delete state.user.districtId;
  state.user.readScope = "province";
  state.user.provinceId = randomUUID();
  assert.equal((await (await get(accessToken)).json()).count, 0);
});

test("province list rejects every query option, including former filters and pagination", async t => {
  const { state, provinces, districts, substations } = fixtures(t);
  const accessToken = token(state.user.publicId);
  for (const query of ["?limit=1", "?offset=0", "?limit=0", "?limit=201", "?offset=-1", "?offset=1.5", "?limit=1&limit=2", "?provinceId=invalid", "?extra=1", "?sort=name", "?status=active",
    `?provinceId=${provinces[0].publicId}`, `?districtId=${districts[0].publicId}`, `?substationId=${substations[0].publicId}`,
    `?provinceId=${provinces[1].publicId}&districtId=${districts[0].publicId}`,
    `?districtId=${districts[0].publicId}&substationId=${substations[2].publicId}`]) {
    const response = await get(accessToken, query);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("last-modified"), null);
  }
});

test("private validators are stable, scoped, and evaluated only after fresh authentication", async t => {
  const { state, provinces } = fixtures(t);
  const id = state.user.publicId;
  const accessToken = token(id);
  state.user.readScope = "province";
  state.user.provinceId = provinces[0].publicId;
  const response = await get(accessToken);
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  const tag = response.headers.get("etag");
  await response.text();
  const repeated = await get(accessToken);
  assert.equal(repeated.headers.get("etag"), tag);
  await repeated.text();
  async function conditional(authorization) {
    return new Promise((resolve, reject) => {
      http.get(origin, { headers: { ...(authorization ? { Authorization: authorization } : {}), "If-None-Match": tag } }, response => {
        let body = "";
        response.on("data", chunk => body += chunk);
        response.on("end", () => resolve({ status: response.statusCode, body }));
      }).on("error", reject);
    });
  }
  assert.deepEqual(await conditional(`Bearer ${accessToken}`), { status: 304, body: "" });
  assert.equal((await conditional()).status, 401);
  state.user.publicId = randomUUID();
  const sameScope = await get(token(state.user.publicId));
  assert.notEqual(sameScope.headers.get("etag"), tag);
  assert.equal((await sameScope.json()).items[0].id, provinces[0].publicId);
  state.user.publicId = id;
  state.user.role = "admin";
  state.user.readScope = "national";
  delete state.user.provinceId;
  const changed = await get(accessToken);
  assert.notEqual(changed.headers.get("etag"), tag);
  await changed.text();
  state.subject = id;
  state.user = null;
  assert.equal((await conditional(`Bearer ${accessToken}`)).status, 401);
});

test("read limits and database failures fail closed with sanitized standard errors", async t => {
  const { state } = fixtures(t);
  const accessToken = token(state.user.publicId);
  t.mock.method(limits, "checkUserReadLimit", async () => 30);
  const limited = await get(accessToken);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal((await limited.json()).code, "RATE_LIMIT_EXCEEDED");
  t.mock.method(models.User, "findOne", () => ({ select() { return this; }, lean: async () => { throw new Error("private database error"); } }));
  const failed = await get(accessToken);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
});

test("OpenAPI documents the protected province list and bearer authentication", async () => {
  const response = await fetch(origin.replace(/\/provinces$/, "/openapi.json"));
  const spec = await response.json();
  assert.deepEqual(spec.paths["/provinces"].get.security, [{ UserBearer: [] }]);
  assert.equal(spec.components.securitySchemes.UserBearer.scheme, "bearer");
  assert.equal(spec.paths["/provinces"].post, undefined);
  assert.deepEqual(spec.paths["/provinces"].get.parameters.filter(parameter => parameter.in === "query"), []);
  assert.deepEqual(spec.components.schemas.ProvinceList.required, ["count", "items"]);
  assert.deepEqual(Object.keys(spec.components.schemas.ProvinceList.properties), ["count", "items"]);
  for (const status of ["200", "304", "400", "401", "406", "429", "500"]) assert.ok(spec.paths["/provinces"].get.responses[status]);
});
