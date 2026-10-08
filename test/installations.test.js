const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "isolated-installation-create-tests-key-at-least-32-bytes";
process.env.JWT_ISSUER = "installation-create-tests";
process.env.JWT_AUDIENCE = "installation-create-api";
const config = require("../src/config/jwt");
const app = require("../src/app");
const models = require("../src/models");
const { Counter } = require("../src/services/token-rate-limit.service");
const binary = process.env.MONGOD_BINARY || (process.platform === "win32" ? "C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe" : "/usr/bin/mongod");
const available = existsSync(binary);
let processHandle, directory, server, origin, installationId, client;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function token(claims = {}, options = {}) {
  return jwt.sign({ actor: "installation", scope: "installation-write", ...claims }, config.signingKey,
    { algorithm: "HS256", subject: installationId, issuer: config.issuer, audience: config.audience, expiresIn: 900, ...options });
}
async function analyst(fields = {}) {
  const user = await models.User.create({ email: `${randomUUID()}@example.com`, passwordHash: "test-only-hash",
    role: "user", readScope: "national", ...fields });
  const access = jwt.sign({ actor: "user", role: "admin", readScope: "national" }, config.signingKey,
    { algorithm: "HS256", subject: user.publicId, issuer: config.issuer, audience: config.audience, expiresIn: 900 });
  return { user, access };
}
// Raw HTTP preserves conditional headers without fetch adding cache-bypass flags.
function rawGet(resource, access, headers) {
  return new Promise((resolve, reject) => {
    http.get(`${origin}${resource}`, {
      headers: { ...(access ? { Authorization: `Bearer ${access}` } : {}), ...headers },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text, body: text ? JSON.parse(text) : null }));
      response.on("error", reject);
    }).on("error", reject);
  });
}
before(async () => {
  if (!available) return;
  directory = await mkdtemp(path.join(os.tmpdir(), "solar-installation-create-test-"));
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  processHandle = spawn(binary, ["--dbpath", directory, "--port", String(port), "--bind_ip", "127.0.0.1", "--replSet", "installationCreateTests", "--logpath", path.join(directory, "mongod.log")], { windowsHide: true, stdio: "ignore" });
  const directUri = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  for (let attempt = 0; ; attempt++) {
    try {
      client = new mongoose.mongo.MongoClient(directUri, { serverSelectionTimeoutMS: 500 });
      await client.connect();
      break;
    } catch (error) {
      await client?.close();
      if (attempt > 40 || processHandle.exitCode !== null) throw error;
      await delay(200);
    }
  }
  await client.db("admin").command({ replSetInitiate: { _id: "installationCreateTests", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  for (let attempt = 0; ; attempt++) {
    if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) break;
    if (attempt > 100) throw new Error("Isolated replica set did not become primary.");
    await delay(100);
  }
  await mongoose.connect(`mongodb://127.0.0.1:${port}/installation_create_tests_${randomUUID()}?replicaSet=installationCreateTests`);
  for (const model of [...Object.values(models), Counter]) await model.init();
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}/api/v1.0`;
});
beforeEach(async () => {
  if (!available) return;
  // Raw cleanup is confined to this disposable local database; API writes use models.
  for (const model of [...Object.values(models), Counter]) await model.collection.deleteMany({});
  const province = await models.Province.create({ name: "Test province" });
  const district = await models.District.create({ name: "Test district", provinceId: province.publicId });
  const substation = await models.GridSubstation.create({ name: "Test substation", districtId: district.publicId });
  const installation = await models.SolarInstallation.create({ substationId: substation.publicId, meterId: "TEST-METER", deviceCredentialHash: "test-only-hash" });
  installationId = installation.publicId;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  await client?.close();
  if (processHandle && processHandle.exitCode === null) {
    const exited = once(processHandle, "exit");
    processHandle.kill();
    await exited;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});
const integration = (name, fn) => test(name, { skip: !available && "Install mongod or set MONGOD_BINARY for isolated replica-set tests." }, fn);

async function fixture() {
  const { user, access } = await analyst({ role: "admin" });
  const existing = await models.SolarInstallation.findOne({ publicId: installationId });
  const input = { substationId: existing.substationId, meterId: " NEW-METER ", deviceSecret: " independent provisioning secret " };
  return { user, access, input };
}
function create(input, access, headers = {}) {
  return fetch(`${origin}/installations`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(access ? { Authorization: `Bearer ${access}` } : {}), ...headers,
  }, body: JSON.stringify(input) });
}
async function errorResponse(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["code", "details", "message"]);
  assert.equal(body.code, code);
  assert.deepEqual(body.details, []);
}

integration("admin creation persists public identity and salted secret; Location GET shares ETag; supplied secret authenticates", async () => {
  const { input, access } = await fixture();
  const response = await create(input, access);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, { id: body.id, substationId: input.substationId, meterId: "NEW-METER", status: "active" });
  assert.match(body.id, require("../src/services/user-principal").publicUuid);
  const location = response.headers.get("location");
  assert.equal(location, `/api/v1.0/installations/${body.id}`);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get("last-modified"), null);
  const detail = await rawGet(`/installations/${body.id}`, access, {});
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, body);
  assert.equal(detail.headers.etag, etag);
  const stored = await models.SolarInstallation.findOne({ publicId: body.id }).select("+deviceCredentialHash");
  assert.match(stored.deviceCredentialHash, /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await require("../src/services/passwords").verifyPassword(input.deviceSecret, stored.deviceCredentialHash), true);
  assert.equal(await models.SolarInstallation.countDocuments({}), 2);
  const login = await fetch(`${origin}/auth/device-tokens`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meterId: body.meterId, deviceSecret: input.deviceSecret }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).installationId, body.id);
  const wrong = await fetch(`${origin}/auth/device-tokens`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meterId: body.meterId, deviceSecret: input.deviceSecret.trim() }) });
  assert.equal(wrong.status, 401);
});

integration("current stored role controls creation despite stale JWT role; wrong actors and absent users are unauthorized", async () => {
  const { input, access, user } = await fixture();
  for (const denied of [null, "invalid", token(), token({}, { expiresIn: -1 })]) {
    const response = await create(input, denied);
    await errorResponse(response, 401, "UNAUTHORIZED");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  const ordinary = await analyst(); // JWT deliberately claims admin.
  await errorResponse(await create(input, ordinary.access), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "user" });
  await errorResponse(await create(input, access), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "admin" });
  const staleUserToken = jwt.sign({ actor: "user", role: "user" }, config.signingKey,
    { subject: user.publicId, issuer: config.issuer, audience: config.audience, expiresIn: 900 });
  assert.equal((await create(input, staleUserToken)).status, 201);
  await models.User.deleteOne({ publicId: user.publicId });
  await errorResponse(await create({ ...input, meterId: "ANOTHER" }, access), 401, "UNAUTHORIZED");
});

integration("rejects invalid shapes, UUIDs, unknown fields and media/parser failures without writes", async () => {
  const { input, access } = await fixture();
  for (const invalid of [[], {}, { ...input, substationId: "bad" }, { ...input, substationId: randomUUID().toUpperCase() },
    { ...input, meterId: " " }, { ...input, deviceSecret: " " }, { ...input, meterId: 5 },
    { ...input, deviceSecret: { $ne: null } }, { substationId: input.substationId, meterId: "missing-secret" },
    ...["id", "publicId", "status", "deviceCredentialHash", "extra"].map(field => ({ ...input, [field]: "forbidden" }))]) {
    await errorResponse(await create(invalid, access), 400, "INVALID_REQUEST");
  }
  await errorResponse(await create(input, access, { "Content-Type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
  const malformed = await fetch(`${origin}/installations`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` }, body: "{" });
  await errorResponse(malformed, 400, "INVALID_JSON");
  await errorResponse(await create({ ...input, deviceSecret: "x".repeat(110000) }, access), 413, "PAYLOAD_TOO_LARGE");
  const unacceptable = await create(input, access, { Accept: "text/html" });
  assert.equal(unacceptable.status, 406);
  assert.equal(await unacceptable.text(), "");
  assert.equal(await models.SolarInstallation.countDocuments({}), 1);
  assert.equal(await Counter.countDocuments({}), 0);
});

integration("missing substation returns 404; active and inactive meter duplicates return 409", async () => {
  const { input, access } = await fixture();
  await errorResponse(await create({ ...input, substationId: randomUUID() }, access), 404, "NOT_FOUND");
  for (const status of ["active", "inactive"]) {
    await models.SolarInstallation.updateOne({ publicId: installationId }, { status });
    await errorResponse(await create({ ...input, meterId: " TEST-METER " }, access), 409, "DUPLICATE_METER_ID");
  }
  assert.equal(await models.SolarInstallation.countDocuments({}), 1);
});

integration("concurrent duplicate creation stores exactly one installation", async () => {
  const { input, access } = await fixture();
  const responses = await Promise.all([create(input, access), create(input, access)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(await models.SolarInstallation.countDocuments({ meterId: "NEW-METER" }), 1);
});

integration("shared admin limit allows 30 valid attempts and returns sanitized 429 with Retry-After", async () => {
  const { input, access } = await fixture();
  for (let i = 0; i < 30; i++) {
    await errorResponse(await create({ ...input, substationId: randomUUID() }, access), 404, "NOT_FOUND");
  }
  const response = await create(input, access);
  await errorResponse(response, 429, "RATE_LIMIT_EXCEEDED");
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(await models.SolarInstallation.countDocuments({}), 1);
  const other = await analyst({ role: "admin" });
  assert.equal((await create(input, other.access)).status, 201);
});

integration("persistence failures are sanitized without credentials or validators", async t => {
  const { input, access } = await fixture();
  t.mock.method(models.SolarInstallation, "create", async () => {
    throw new Error(`private diagnostics ${input.deviceSecret}`);
  });
  await errorResponse(await create(input, access), 500, "INTERNAL_SERVER_ERROR");
  assert.equal(await models.SolarInstallation.countDocuments({}), 1);
});

test("OpenAPI documents implemented creation, public response and admin policy", () => {
  const spec = require("../docs/openapi.json");
  const operation = spec.paths["/installations"].post;
  assert.deepEqual(operation.security, [{ UserBearer: [] }]);
  const input = spec.components.schemas.InstallationInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["substationId", "meterId", "deviceSecret"]);
  assert.deepEqual(Object.keys(input.properties), input.required);
  assert.equal(input.properties.deviceSecret.writeOnly, true);
  assert.equal(operation.responses[201].content["application/json"].schema.$ref, "#/components/schemas/SolarInstallation");
  for (const name of ["Location", "ETag", "Cache-Control"]) assert.ok(operation.responses[201].headers[name]);
  for (const status of [400, 401, 403, 404, 406, 409, 413, 415, 429, 500]) assert.ok(operation.responses[status]);
  assert.ok(spec.paths["/installations/{installationId}"].patch);
  assert.ok(spec.paths["/installations/{installationId}"].delete);
});

function patch(access, input = { status: "inactive" }, ifMatch, id = installationId, headers = {}) {
  return fetch(`${origin}/installations/${id}`, { method: "PATCH", headers: {
    "Content-Type": "application/json", ...(access ? { Authorization: `Bearer ${access}` } : {}),
    ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}), ...headers,
  }, body: input === undefined ? undefined : JSON.stringify(input) });
}
async function installationSnapshot() {
  return models.SolarInstallation.collection.findOne({ publicId: installationId });
}
async function currentTag(access) {
  return (await rawGet(`/installations/${installationId}`, access, {})).headers.etag;
}
const readingInput = { recordedAt: new Date("2026-10-08T06:30:00Z"), powerKw: 3, energyKwh: 10, voltageV: 230 };
const { createReading } = require("../src/features/readings/readings.service");
const { updateInstallationStatus } = require("../src/features/installations/installations.service");

integration("PATCH deactivates and repeats without changing credentials, relationships, history or public representation", async () => {
  const { access } = await fixture();
  const secret = " test provisioning secret ";
  await models.SolarInstallation.updateOne({ publicId: installationId }, { deviceCredentialHash: await require("../src/services/passwords").hashPassword(secret) });
  const login = () => fetch(`${origin}/auth/device-tokens`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meterId: "TEST-METER", deviceSecret: secret }) });
  const activeLogin = await login();
  assert.equal(activeLogin.status, 200);
  const deviceAccess = (await activeLogin.json()).access_token;
  await createReading(installationId, readingInput);
  const before = await installationSnapshot();
  const history = await models.GenerationReading.collection.find({ installationId }).toArray();
  const oldTag = await currentTag(access);
  const substation = await models.GridSubstation.findOne({ publicId: before.substationId });
  const summaryPath = `/summarize-district-generation?districtId=${substation.districtId}`;
  const oldList = await rawGet("/installations", access, {});
  const oldOverview = await rawGet(`/installations/${installationId}/overview`, access, {});
  const oldSummary = await rawGet(summaryPath, access, {});
  assert.equal(oldSummary.body.freshInstallationCount + oldSummary.body.staleInstallationCount, 1);
  const response = await patch(access);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { id: installationId, substationId: before.substationId, meterId: before.meterId, status: "inactive" });
  const tag = response.headers.get("etag");
  assert.notEqual(tag, oldTag);
  assert.match(tag, /^"[a-f0-9]{64}"$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("last-modified"), null);
  const after = await installationSnapshot();
  assert.deepEqual(after, { ...before, status: "inactive" });
  const repeat = await patch(access);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), body);
  assert.equal(repeat.headers.get("etag"), tag);
  assert.deepEqual(await installationSnapshot(), after);
  assert.deepEqual(await models.GenerationReading.collection.find({ installationId }).toArray(), history);
  const retained = await rawGet(`/installations/${installationId}/readings`, access, {});
  assert.equal(retained.status, 200);
  assert.equal(retained.body.count, 1);
  assert.equal(await currentTag(access), tag);
  const newList = await rawGet("/installations", access, {});
  const newOverview = await rawGet(`/installations/${installationId}/overview`, access, {});
  const newSummary = await rawGet(summaryPath, access, {});
  assert.notEqual(newList.headers.etag, oldList.headers.etag);
  assert.equal(newList.body.items[0].status, "inactive");
  assert.notEqual(newOverview.headers.etag, oldOverview.headers.etag);
  assert.equal(newOverview.body.installation.status, "inactive");
  assert.deepEqual(newOverview.body.latestReading, oldOverview.body.latestReading);
  assert.notEqual(newSummary.headers.etag, oldSummary.headers.etag);
  assert.equal(newSummary.body.freshInstallationCount + newSummary.body.staleInstallationCount, 0);
  assert.equal(newSummary.body.todayEnergyKwh, oldSummary.body.todayEnergyKwh);
  assert.equal(newSummary.body.incompleteEnergyInstallationCount, oldSummary.body.incompleteEnergyInstallationCount);
  const inactiveLogin = await login();
  assert.equal(inactiveLogin.status, 403);
  assert.equal((await inactiveLogin.json()).code, "INSTALLATION_INACTIVE");
  const rejected = await fetch(`${origin}/installations/${installationId}/readings`, { method: "POST",
    headers: { Authorization: `Bearer ${deviceAccess}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...readingInput, recordedAt: "2026-10-08T06:45:00Z" }) });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, "INSTALLATION_INACTIVE");
  assert.deepEqual(await models.GenerationReading.collection.find({ installationId }).toArray(), history);
});

integration("PATCH authenticates current admin before input/preconditions and rejects invalid bodies and paths without mutation", async () => {
  const { access, user } = await fixture();
  const before = await installationSnapshot();
  for (const denied of [null, "invalid", token(), token({}, { expiresIn: -1 })]) {
    const response = await patch(denied, {}, "bad", "bad");
    await errorResponse(response, 401, "UNAUTHORIZED");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  const ordinary = await analyst();
  await errorResponse(await patch(ordinary.access, {}, "bad", "bad"), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "user" });
  await errorResponse(await patch(access), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "admin" });
  await errorResponse(await patch(access, { status: "inactive" }, "bad", "bad"), 400, "INVALID_REQUEST");
  for (const input of [{}, [], null, { status: "retired" }, { status: "INACTIVE" }, { status: " inactive " }, { status: false },
    ...["id", "meterId", "substationId", "deviceSecret", "deviceCredentialHash"].map(field => ({ status: "inactive", [field]: "forbidden" }))]) {
    await errorResponse(await patch(access, input, "bad"), 400, input === null ? "INVALID_JSON" : "INVALID_REQUEST");
  }
  const empty = await fetch(`${origin}/installations/${installationId}`, { method: "PATCH", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" } });
  await errorResponse(empty, 400, "INVALID_REQUEST");
  await errorResponse(await patch(access, { status: "inactive" }, undefined, installationId, { "Content-Type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
  await errorResponse(await patch(access, { status: "inactive" }, "bad", randomUUID()), 404, "NOT_FOUND");
  assert.deepEqual(await installationSnapshot(), before);
  assert.equal(await models.GenerationReading.countDocuments({}), 0);
});

integration("PATCH strong If-Match accepts lists and wildcard, rejects weak/stale tags even on no-op, and preserves data on failure", async () => {
  const { access } = await fixture();
  await createReading(installationId, readingInput);
  const before = await installationSnapshot();
  const history = await models.GenerationReading.collection.find({ installationId }).toArray();
  const activeTag = await currentTag(access);
  for (const header of ['"stale"', `W/${activeTag}`, 'W/"other", "stale"']) {
    await errorResponse(await patch(access, { status: "inactive" }, header), 412, "PRECONDITION_FAILED");
    assert.deepEqual(await installationSnapshot(), before);
  }
  for (const header of ["", "unquoted", '"unterminated', '"tag",', ',"tag"', '*, "tag"', '"tag" "other"', 'w/"tag"']) {
    await errorResponse(await patch(access, { status: "inactive" }, header), 400, "INVALID_REQUEST");
    assert.deepEqual(await installationSnapshot(), before);
  }
  const matched = await patch(access, { status: "inactive" }, `W/${activeTag}, "unrelated", ${activeTag}`);
  assert.equal(matched.status, 200);
  const inactiveTag = matched.headers.get("etag");
  const inactive = await installationSnapshot();
  await errorResponse(await patch(access, { status: "inactive" }, activeTag), 412, "PRECONDITION_FAILED");
  assert.deepEqual(await installationSnapshot(), inactive);
  for (const header of [inactiveTag, `"other", ${inactiveTag}`, "*"]) {
    const repeat = await patch(access, { status: "inactive" }, header);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.headers.get("etag"), inactiveTag);
    assert.deepEqual(await installationSnapshot(), inactive);
  }
  assert.deepEqual(await models.GenerationReading.collection.find({ installationId }).toArray(), history);
});

integration("PATCH shares the creation admin-write budget and sanitizes transaction failures", async t => {
  const { access, input } = await fixture();
  for (let i = 0; i < 29; i++) await errorResponse(await create({ ...input, substationId: randomUUID() }, access), 404, "NOT_FOUND");
  assert.equal((await patch(access)).status, 200);
  const before = await installationSnapshot();
  const limited = await patch(access);
  await errorResponse(limited, 429, "RATE_LIMIT_EXCEEDED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.deepEqual(await installationSnapshot(), before);
  const other = await analyst({ role: "admin" });
  t.mock.method(mongoose.connection, "transaction", async () => { throw new Error("private transaction details"); });
  await errorResponse(await patch(other.access), 500, "INTERNAL_SERVER_ERROR");
});

integration("PATCH retries stale comparisons after write conflicts for either status, including no-ops", async t => {
  const { access } = await fixture();
  for (const status of ["inactive", "active"]) for (const noOp of [false, true]) {
    await models.SolarInstallation.updateOne({ publicId: installationId }, { status: noOp ? status : status === "active" ? "inactive" : "active" });
    const tag = await currentTag(access);
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { reached = resolve; });
    const original = models.SolarInstallation.findOneAndUpdate;
    let attempts = 0;
    const mock = t.mock.method(models.SolarInstallation, "findOneAndUpdate", function (...args) {
      const query = original.apply(this, args);
      const execute = query.exec;
      query.exec = async function (...execArgs) {
        attempts++;
        if (attempts === 1) { reached(); await gate; }
        return execute.apply(this, execArgs);
      };
      return query;
    });
    const pending = patch(access, { status }, tag);
    await ready;
    // The competing write commits after PATCH read/compared its snapshot.
    if (noOp) await models.SolarInstallation.collection.updateOne({ publicId: installationId }, { $set: { meterId: `CHANGED-${randomUUID()}` } });
    else await models.SolarInstallation.updateOne({ publicId: installationId }, { status });
    const committed = await installationSnapshot();
    release();
    await errorResponse(await pending, 412, "PRECONDITION_FAILED");
    mock.mock.restore();
    assert.deepEqual(await installationSnapshot(), committed);
  }
});

integration("reactivation retains data, restores device login/unexpired-token writes, and never revives expired tokens", async () => {
  const { access } = await fixture();
  const secret = " reusable device provisioning secret ";
  await models.SolarInstallation.updateOne({ publicId: installationId }, { deviceCredentialHash: await require("../src/services/passwords").hashPassword(secret) });
  const before = await installationSnapshot();
  const activeTag = await currentTag(access);
  const deviceAccess = token();
  const claims = jwt.decode(deviceAccess);
  await createReading(installationId, readingInput);
  const history = await models.GenerationReading.collection.find({ installationId }).toArray();
  assert.equal((await patch(access)).status, 200);
  const inactive = await installationSnapshot();
  const inactiveTag = await currentTag(access);
  const submit = accessToken => fetch(`${origin}/installations/${installationId}/readings`, { method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...readingInput, recordedAt: "2026-10-08T06:45:00Z" }) });
  assert.equal((await submit(deviceAccess)).status, 403);
  const ordinary = await analyst();
  await errorResponse(await patch(ordinary.access, { status: "active" }), 403, "FORBIDDEN");
  await errorResponse(await patch(access, { status: "active" }, activeTag), 412, "PRECONDITION_FAILED");
  await errorResponse(await patch(access, { status: "active" }, `W/${inactiveTag}`), 412, "PRECONDITION_FAILED");
  assert.deepEqual(await installationSnapshot(), inactive);
  const activated = await patch(access, { status: "active" }, `"other", ${inactiveTag}`);
  assert.equal(activated.status, 200);
  assert.equal((await activated.json()).status, "active");
  assert.equal(activated.headers.get("etag"), activeTag);
  assert.deepEqual(await installationSnapshot(), before);
  assert.deepEqual(await models.GenerationReading.collection.find({ installationId }).toArray(), history);
  for (const condition of [undefined, activeTag, "*"]) {
    const repeat = await patch(access, { status: "active" }, condition);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.headers.get("etag"), activeTag);
    assert.deepEqual(await installationSnapshot(), before);
  }
  await errorResponse(await patch(access, { status: "active" }, inactiveTag), 412, "PRECONDITION_FAILED");
  const login = await fetch(`${origin}/auth/device-tokens`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meterId: before.meterId, deviceSecret: secret }) });
  assert.equal(login.status, 200);
  const newToken = (await login.json()).access_token;
  assert.equal(jwt.decode(newToken).sub, installationId);
  assert.equal((await submit(token({}, { expiresIn: -1 }))).status, 401);
  assert.equal((await submit(deviceAccess)).status, 201);
  assert.equal(jwt.decode(deviceAccess).exp, claims.exp);
  assert.equal(await models.GenerationReading.countDocuments({ installationId }), 2);
  const substation = await models.GridSubstation.findOne({ publicId: before.substationId });
  const summary = await rawGet(`/summarize-district-generation?districtId=${substation.districtId}`, access, {});
  assert.equal(summary.body.freshInstallationCount + summary.body.staleInstallationCount, 1);
  assert.equal((await rawGet(`/installations/${installationId}/overview`, access, {})).body.installation.status, "active");
});

integration("PATCH failure after parent mutation rolls back status and temporary lock", async t => {
  const { access } = await fixture();
  await createReading(installationId, readingInput);
  const before = await installationSnapshot();
  const history = await models.GenerationReading.collection.find({ installationId }).toArray();
  const original = models.SolarInstallation.updateOne;
  t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
    if (args[1].$unset?._ingestionLock !== undefined) throw new Error("private cleanup diagnostics");
    return original.apply(this, args);
  });
  await errorResponse(await patch(access), 500, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(await installationSnapshot(), before);
  assert.deepEqual(await models.GenerationReading.collection.find({ installationId }).toArray(), history);
});

integration("PATCH committing first makes already-authorized ingestion retry and reject inactive state", async t => {
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const original = models.SolarInstallation.findOneAndUpdate;
  t.mock.method(models.SolarInstallation, "findOneAndUpdate", function (...args) {
    const query = original.apply(this, args), execute = query.exec;
    query.exec = async function (...execArgs) {
      const result = await execute.apply(this, execArgs);
      reached(); await gate; return result;
    };
    return query;
  });
  const deactivation = updateInstallationStatus(installationId, "inactive");
  await ready;
  let attempted;
  const attempt = new Promise(resolve => { attempted = resolve; });
  const originalUpdate = models.SolarInstallation.updateOne;
  t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
    if (args[0].status === "active") attempted();
    return originalUpdate.apply(this, args);
  });
  const rejected = assert.rejects(createReading(installationId, readingInput), error => error.status === 403 && error.code === "INSTALLATION_INACTIVE");
  await attempt; release(); await deactivation; await rejected;
  assert.equal(await models.GenerationReading.countDocuments({}), 0);
  assert.equal((await installationSnapshot()).status, "inactive");
});

integration("ingestion committing first makes PATCH retry while preserving the new history", async t => {
  const { access } = await fixture();
  const tag = await currentTag(access);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const originalSave = models.GenerationReading.prototype.save;
  t.mock.method(models.GenerationReading.prototype, "save", async function (...args) {
    const result = await originalSave.apply(this, args); reached(); await gate; return result;
  });
  const ingestion = createReading(installationId, readingInput);
  await ready;
  let attempted, attempts = 0;
  const attempt = new Promise(resolve => { attempted = resolve; });
  const original = models.SolarInstallation.findOneAndUpdate;
  t.mock.method(models.SolarInstallation, "findOneAndUpdate", function (...args) {
    attempts++; attempted(); return original.apply(this, args);
  });
  const pending = patch(access, { status: "inactive" }, tag);
  await attempt; release(); await ingestion;
  assert.equal((await pending).status, 200);
  assert.ok(attempts >= 2);
  assert.equal(await models.GenerationReading.countDocuments({ installationId }), 1);
  assert.equal((await installationSnapshot()).status, "inactive");
  assert.equal((await installationSnapshot())._ingestionLock, undefined);
});

test("If-Match parser respects opaque commas, strong tags, whitespace and strict syntax", () => {
  const { parseIfMatch, ifMatchAllows } = require("../src/features/installations/installation-precondition");
  assert.equal(ifMatchAllows(parseIfMatch(undefined), '"tag"'), true);
  assert.equal(ifMatchAllows(parseIfMatch(' W/"tag", "comma,inside", "tag" '), '"tag"'), true);
  assert.equal(ifMatchAllows(parseIfMatch('W/"tag"'), '"tag"'), false);
  assert.equal(ifMatchAllows(parseIfMatch("*"), '"tag"'), true);
  for (const invalid of ["", "tag", '"a",', '*, "a"', '"a";"b"', '"a\\"b"', '"line\nbreak"']) assert.throws(() => parseIfMatch(invalid));
});

test("OpenAPI PATCH documents strict status updates, optional If-Match, shared limits and public ETag", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths["/installations/{installationId}"];
  assert.deepEqual(Object.keys(resource), ["get", "patch", "delete"]);
  const operation = resource.patch;
  assert.deepEqual(operation.security, [{ UserBearer: [] }]);
  const input = spec.components.schemas.InstallationStatusInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["status"]);
  assert.deepEqual(input.properties, { status: { type: "string", enum: ["active", "inactive"] } });
  assert.equal(operation.parameters.find(p => p.name === "If-Match").required, false);
  assert.equal(operation.responses[200].headers.ETag.$ref, "#/components/headers/InstallationETag");
  assert.equal(operation.responses[200].content["application/json"].schema.$ref, "#/components/schemas/SolarInstallation");
  for (const status of [400, 401, 403, 404, 406, 412, 413, 415, 429, 500]) assert.ok(operation.responses[status]);
  assert.ok(resource.delete);
});

function remove(access, ifMatch, id = installationId, body, headers = {}) {
  return fetch(`${origin}/installations/${id}`, { method: "DELETE", headers: {
    ...(access ? { Authorization: `Bearer ${access}` } : {}),
    ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}), ...headers,
  }, ...(body !== undefined ? { body } : {}) });
}
async function deleted(response) {
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  for (const header of ["etag", "last-modified", "content-type"]) assert.equal(response.headers.get(header), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
}
const { deleteInstallation } = require("../src/features/installations/installations.service");

integration("DELETE empty active/inactive installations supports unconditional, strong/list/wildcard preconditions and retains parents", async () => {
  const { access, input } = await fixture();
  const parents = await Promise.all([models.Province.collection.find({}).toArray(), models.District.collection.find({}).toArray(), models.GridSubstation.collection.find({}).toArray()]);
  for (const status of ["active", "inactive"]) for (const mode of ["absent", "single", "list", "wildcard"]) {
    if (!await installationSnapshot()) {
      const replacement = await models.SolarInstallation.create({ substationId: input.substationId, meterId: "TEST-METER", status, deviceCredentialHash: "fixture-only-hash" });
      installationId = replacement.publicId;
    } else await models.SolarInstallation.updateOne({ publicId: installationId }, { status });
    const tag = await currentTag(access);
    const header = mode === "absent" ? undefined : mode === "single" ? tag : mode === "list" ? `W/${tag}, "other", ${tag}` : "*";
    await deleted(await remove(access, header));
    assert.equal(await installationSnapshot(), null);
    await errorResponse(await remove(access, "bad"), 404, "NOT_FOUND");
    assert.equal((await rawGet(`/installations/${installationId}`, access, {})).status, 404);
  }
  assert.equal(await models.GenerationReading.countDocuments({}), 0);
  assert.deepEqual(await Promise.all([models.Province.collection.find({}).toArray(), models.District.collection.find({}).toArray(), models.GridSubstation.collection.find({}).toArray()]), parents);
});

integration("DELETE history guard preserves active/inactive records and evaluates If-Match before history", async t => {
  const { access } = await fixture();
  await createReading(installationId, readingInput);
  const history = await models.GenerationReading.collection.find({}).toArray();
  const original = models.GenerationReading.exists;
  let guards = 0;
  t.mock.method(models.GenerationReading, "exists", function (...args) { guards++; return original.apply(this, args); });
  for (const status of ["active", "inactive"]) {
    await models.SolarInstallation.updateOne({ publicId: installationId }, { status });
    const before = await installationSnapshot();
    const tag = await currentTag(access);
    const previousGuards = guards;
    for (const header of ['"stale"', `W/${tag}`]) await errorResponse(await remove(access, header), 412, "PRECONDITION_FAILED");
    await errorResponse(await remove(access, "bad"), 400, "INVALID_REQUEST");
    assert.equal(guards, previousGuards);
    for (const header of [undefined, tag, "*"]) await errorResponse(await remove(access, header), 409, "INSTALLATION_HAS_READINGS");
    assert.deepEqual(await installationSnapshot(), before);
    assert.deepEqual(await models.GenerationReading.collection.find({}).toArray(), history);
  }
});

integration("DELETE rejects actors, stale admin roles, invalid paths/bodies and missing resources before preconditions", async () => {
  const { access, user } = await fixture();
  const before = await installationSnapshot();
  for (const denied of [null, "invalid", token(), token({}, { expiresIn: -1 })]) {
    const response = await remove(denied, "bad", "bad");
    await errorResponse(response, 401, "UNAUTHORIZED");
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
  const ordinary = await analyst();
  await errorResponse(await remove(ordinary.access, "bad", "bad"), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "user" });
  await errorResponse(await remove(access), 403, "FORBIDDEN");
  await models.User.updateOne({ publicId: user.publicId }, { role: "admin" });
  await errorResponse(await remove(access, "bad", "bad"), 400, "INVALID_REQUEST");
  for (const [body, type, code] of [["{}", "application/json", "INVALID_REQUEST"], ["[]", "application/json", "INVALID_REQUEST"],
    ["text", "text/plain", "INVALID_REQUEST"], ["binary", "application/octet-stream", "INVALID_REQUEST"], ["{", "application/json", "INVALID_JSON"]]) {
    await errorResponse(await remove(access, "bad", installationId, body, { "Content-Type": type }), 400, code);
  }
  await errorResponse(await remove(access, "bad", randomUUID()), 404, "NOT_FOUND");
  await errorResponse(await remove(access, '"stale"', randomUUID()), 404, "NOT_FOUND");
  assert.deepEqual(await installationSnapshot(), before);
});

integration("DELETE rejects streamed non-JSON bodies and accepts an empty body with optional media headers", async () => {
  const { access } = await fixture();
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${origin}/installations/${installationId}`, { method: "DELETE", headers: {
      Authorization: `Bearer ${access}`, "Content-Type": "text/plain", "Transfer-Encoding": "chunked",
    } }, res => { let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) })); });
    request.on("error", reject); request.write("streamed body"); request.end();
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, "INVALID_REQUEST");
  assert.ok(await installationSnapshot());
  await deleted(await remove(access, undefined, installationId, undefined, { "Content-Type": "application/json", "Content-Length": "0" }));
});

integration("DELETE rejects old tokens and meter re-registration gets a new UUID without old-token ownership", async () => {
  const { access, input } = await fixture();
  const oldId = installationId, oldToken = token();
  const beforeList = await rawGet("/installations", access, {});
  const substation = await models.GridSubstation.findOne({ publicId: input.substationId });
  const summaryPath = `/summarize-district-generation?districtId=${substation.districtId}`;
  const beforeSummary = await rawGet(summaryPath, access, {});
  await deleted(await remove(access));
  const afterList = await rawGet("/installations", access, {});
  const afterSummary = await rawGet(summaryPath, access, {});
  assert.equal(afterList.body.count, 0);
  assert.notEqual(afterList.headers.etag, beforeList.headers.etag);
  assert.equal(afterSummary.body.freshInstallationCount + afterSummary.body.staleInstallationCount, 0);
  assert.equal(afterSummary.body.incompleteEnergyInstallationCount, 0);
  assert.notEqual(afterSummary.headers.etag, beforeSummary.headers.etag);
  const submit = id => fetch(`${origin}/installations/${id}/readings`, { method: "POST", headers: { Authorization: `Bearer ${oldToken}`, "Content-Type": "application/json" }, body: JSON.stringify(readingInput) });
  assert.equal((await submit(oldId)).status, 401);
  const replacement = await create({ ...input, meterId: "TEST-METER" }, access);
  assert.equal(replacement.status, 201);
  const newId = (await replacement.json()).id;
  assert.notEqual(newId, oldId);
  assert.equal((await submit(oldId)).status, 401);
  assert.equal((await submit(newId)).status, 401);
  assert.equal(await models.GenerationReading.countDocuments({}), 0);
});

integration("DELETE shares POST/PATCH admin limits and rolls back lock on persistence failure", async t => {
  const { access, input } = await fixture();
  for (let i = 0; i < 28; i++) await errorResponse(await create({ ...input, substationId: randomUUID() }, access), 404, "NOT_FOUND");
  assert.equal((await patch(access)).status, 200);
  await errorResponse(await remove(access, undefined, randomUUID()), 404, "NOT_FOUND");
  const before = await installationSnapshot();
  const limited = await remove(access);
  await errorResponse(limited, 429, "RATE_LIMIT_EXCEEDED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const other = await analyst({ role: "admin" });
  t.mock.method(models.SolarInstallation, "deleteOne", async () => { throw new Error("private persistence diagnostics"); });
  await errorResponse(await remove(other.access), 500, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(await installationSnapshot(), before);
});

integration("DELETE conflict reloads the current ETag instead of reusing a stale successful comparison", async t => {
  const { access } = await fixture();
  const tag = await currentTag(access);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const original = models.SolarInstallation.updateOne;
  let writes = 0;
  t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
    const query = original.apply(this, args), execute = query.exec;
    if (args[1].$set?._ingestionLock) query.exec = async function (...execArgs) {
      writes++; if (writes === 1) { reached(); await gate; }
      return execute.apply(this, execArgs);
    };
    return query;
  });
  const pending = remove(access, tag);
  await ready;
  assert.equal((await patch(access)).status, 200);
  const committed = await installationSnapshot();
  release(); await errorResponse(await pending, 412, "PRECONDITION_FAILED");
  assert.deepEqual(await installationSnapshot(), committed);
});

integration("DELETE committing first causes already-authorized ingestion to retry and reject without orphan history", async t => {
  const { access } = await fixture();
  let release, reached, attempted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const attempt = new Promise(resolve => { attempted = resolve; });
  const original = models.SolarInstallation.updateOne;
  t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
    const query = original.apply(this, args), execute = query.exec;
    if (args[1].$set?._ingestionLock && !args[0].status) query.exec = async function (...execArgs) {
      const result = await execute.apply(this, execArgs); reached(); await gate; return result;
    };
    if (args[0].status === "active") attempted();
    return query;
  });
  const deletion = remove(access);
  await ready;
  const rejected = assert.rejects(createReading(installationId, readingInput), error => error.status === 401);
  await attempt; release(); await deleted(await deletion); await rejected;
  assert.equal(await installationSnapshot(), null);
  assert.equal(await models.GenerationReading.countDocuments({}), 0);
});

integration("ingestion committing first makes DELETE retry history guard and retain installation/readings", async t => {
  const { access } = await fixture();
  const tag = await currentTag(access);
  let release, reached, attempted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { reached = resolve; });
  const attempt = new Promise(resolve => { attempted = resolve; });
  const originalSave = models.GenerationReading.prototype.save;
  t.mock.method(models.GenerationReading.prototype, "save", async function (...args) {
    const result = await originalSave.apply(this, args); reached(); await gate; return result;
  });
  const ingestion = createReading(installationId, readingInput);
  await ready;
  const original = models.SolarInstallation.updateOne;
  let attempts = 0;
  t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
    if (args[1].$set?._ingestionLock && !args[0].status) { attempts++; attempted(); }
    return original.apply(this, args);
  });
  const pending = remove(access, tag);
  await attempt; release(); await ingestion;
  await errorResponse(await pending, 409, "INSTALLATION_HAS_READINGS");
  assert.ok(attempts >= 2);
  assert.ok(await installationSnapshot());
  assert.equal((await installationSnapshot())._ingestionLock, undefined);
  assert.equal(await models.GenerationReading.countDocuments({ installationId }), 1);
  assert.equal(await currentTag(access), tag);
});

test("OpenAPI DELETE documents bodyless guarded deletion, preconditions, standard errors and no success validators", () => {
  const op = require("../docs/openapi.json").paths["/installations/{installationId}"].delete;
  assert.deepEqual(op.security, [{ UserBearer: [] }]);
  assert.equal(op.requestBody, undefined);
  assert.equal(op.parameters.find(p => p.name === "If-Match").required, false);
  assert.equal(op.responses[204].content, undefined);
  assert.deepEqual(Object.keys(op.responses[204].headers), ["Cache-Control"]);
  for (const status of [400, 401, 403, 404, 406, 409, 412, 413, 429, 500]) assert.ok(op.responses[status]);
  assert.match(op.responses[409].description, /INSTALLATION_HAS_READINGS/);
});

