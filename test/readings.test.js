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
process.env.JWT_SIGNING_KEY = "isolated-reading-tests-key-at-least-32-bytes";
process.env.JWT_ISSUER = "reading-tests";
process.env.JWT_AUDIENCE = "reading-api";
const config = require("../src/config/jwt");
const app = require("../src/app");
const models = require("../src/models");
const { Counter } = require("../src/services/token-rate-limit.service");
const { createReading } = require("../src/features/readings/readings.service");
const { parseRecordedAt } = require("../src/utils/timestamps");
const binary = process.env.MONGOD_BINARY || (process.platform === "win32" ? "C:/Program Files/MongoDB/Server/8.3/bin/mongod.exe" : "/usr/bin/mongod");
const available = existsSync(binary);
let processHandle, directory, server, origin, installationId, client;
const body = { recordedAt: "2026-10-08T12:00:00+05:30", powerKw: 3.5, energyKwh: 42, voltageV: 230 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function token(claims = {}, options = {}) {
  return jwt.sign({ actor: "installation", scope: "installation-write", ...claims }, config.signingKey,
    { algorithm: "HS256", subject: installationId, issuer: config.issuer, audience: config.audience, expiresIn: 900, ...options });
}
function post(input = body, access = token(), id = installationId, headers = {}) {
  return fetch(`${origin}/installations/${id}/readings`, { method: "POST",
    headers: { "Content-Type": "application/json", ...(access ? { Authorization: `Bearer ${access}` } : {}), ...headers }, body: JSON.stringify(input) });
}
async function count() { return models.GenerationReading.countDocuments({}); }

async function analyst(fields = {}) {
  const user = await models.User.create({ email: `${randomUUID()}@example.com`, passwordHash: "test-only-hash",
    role: "user", readScope: "national", ...fields });
  const access = jwt.sign({ actor: "user", role: "admin", readScope: "national" }, config.signingKey,
    { algorithm: "HS256", subject: user.publicId, issuer: config.issuer, audience: config.audience, expiresIn: 900 });
  return { user, access };
}
// Raw HTTP preserves conditional headers without fetch adding cache-bypass flags.
function read(readingId, access, id = installationId, headers = {}) {
  return rawGet(`/installations/${id}/readings/${readingId}`, access, headers);
}
function list(access, query = "", id = installationId, headers = {}) {
  return rawGet(`/installations/${id}/readings${query}`, access, headers);
}
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
async function createdReading() {
  const response = await post();
  assert.equal(response.status, 201);
  return { body: await response.json(), etag: response.headers.get("etag"), modified: response.headers.get("last-modified") };
}

before(async () => {
  if (!available) return;
  directory = await mkdtemp(path.join(os.tmpdir(), "solar-readings-test-"));
  const socket = net.createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  processHandle = spawn(binary, ["--dbpath", directory, "--port", String(port), "--bind_ip", "127.0.0.1", "--replSet", "readingTests", "--logpath", path.join(directory, "mongod.log")], { windowsHide: true, stdio: "ignore" });
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
  await client.db("admin").command({ replSetInitiate: { _id: "readingTests", members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  for (let attempt = 0; ; attempt++) {
    if ((await client.db("admin").command({ hello: 1 })).isWritablePrimary) break;
    if (attempt > 100) throw new Error("Isolated replica set did not become primary.");
    await delay(100);
  }
  await mongoose.connect(`mongodb://127.0.0.1:${port}/reading_tests_${randomUUID()}?replicaSet=readingTests`);
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

test("timestamp parser rejects overflow, ambiguity and unsupported precision", () => {
  for (const value of ["bad", 123, "2026-10-08", "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-10-08T24:00:00Z", "2026-10-08T12:00:60Z", "2026-10-08T12:00:00", "2026-10-08T12:00:00.1234Z", "2026-10-08T12:00:00+24:00"]) assert.equal(parseRecordedAt(value), null);
  assert.equal(parseRecordedAt("2024-02-29T12:00:00.123Z").toISOString(), "2024-02-29T12:00:00.123Z");
});

integration("valid reading has public server fields, headers, stable ETag and one stored document; duplicate conflicts", async () => {
  const response = await post();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const json = await response.json();
  assert.match(json.id, /^[0-9a-f-]{36}$/);
  assert.equal(json.installationId, installationId);
  assert.equal(json.recordedAt, "2026-10-08T12:00:00.000+05:30");
  assert.equal(json.recordedAtDisplay, "08 Oct 2026, 12:00 PM (Sri Lanka)");
  assert.match(json.receivedAtDisplay, /^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM) \(Sri Lanka\)$/);
  assert.ok(json.receivedAt.endsWith("+05:30"));
  assert.deepEqual(Object.keys(json).sort(), ["id", "installationId", "recordedAt", "receivedAt", "recordedAtDisplay", "receivedAtDisplay", "powerKw", "energyKwh", "voltageV"].sort());
  assert.equal(response.headers.get("location"), `/api/v1.0/installations/${installationId}/readings/${json.id}`);
  assert.equal(response.headers.get("last-modified"), new Date(json.receivedAt).toUTCString());
  const serialized = JSON.stringify(json);
  assert.equal(response.headers.get("etag"), require("etag")(serialized));
  assert.equal(await count(), 1);
  const stored = await models.GenerationReading.findOne({ publicId: json.id });
  assert.equal(stored.receivedAt.getTime(), new Date(json.receivedAt).getTime());
  assert.equal(stored.toObject().recordedAtDisplay, undefined);
  assert.equal(stored.toObject().receivedAtDisplay, undefined);
  const duplicate = await post({ ...body, recordedAt: "2026-10-08T06:30:00Z", powerKw: 9 });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "DUPLICATE_READING");
  assert.equal(await count(), 1);
  assert.equal((await models.GenerationReading.findOne({ publicId: json.id })).powerKw, 3.5);
  assert.equal((await models.SolarInstallation.collection.findOne({ publicId: installationId }))._ingestionLock, undefined);
});

integration("missing invalid expired and user tokens return 401 without insertion", async () => {
  for (const access of [null, "bad", token({}, { expiresIn: -1 }), token({ actor: "user" })]) {
    const res = await post(body, access);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), "Bearer");
  }
  assert.equal(await count(), 0);
});
integration("scope ownership inactive and deleted installation failures never insert", async () => {
  assert.equal((await post(body, token({ scope: "other" }))).status, 403);
  assert.equal((await post(body, token(), randomUUID())).status, 403);
  const access = token();
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  assert.equal((await post(body, access)).status, 403);
  await models.SolarInstallation.deleteOne({ publicId: installationId });
  assert.equal((await post(body, access)).status, 401);
  assert.equal(await count(), 0);
});
integration("invalid bodies and protocol errors never insert", async () => {
  const invalid = [null, [], {}, { powerKw: 1, energyKwh: 1, voltageV: 1 }, { ...body, recordedAt: "invalid" }, { ...body, recordedAt: "2026-02-30T12:00:00Z" }];
  for (const field of ["powerKw", "energyKwh", "voltageV"]) {
    for (const value of [-1, "3", null, {}, true, Infinity, NaN]) invalid.push({ ...body, [field]: value });
    const missing = { ...body }; delete missing[field]; invalid.push(missing);
  }
  for (const field of ["id", "publicId", "_id", "installationId", "receivedAt", "extra"]) invalid.push({ ...body, [field]: "forged" });
  for (const input of invalid) assert.equal((await post(input)).status, 400);
  assert.equal((await post(body, token(), installationId, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post(body, token(), installationId, { Accept: "text/html" })).status, 406);
  for (const [raw, status] of [["{", 400], [JSON.stringify({ padding: "x".repeat(102401) }), 413]]) {
    const response = await fetch(`${origin}/installations/${installationId}/readings`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` }, body: raw });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(await count(), 0);
  assert.equal(await Counter.countDocuments({}), 0);
});
integration("zero and large finite measurements and past/future times have no invented bounds", async () => {
  for (const [recordedAt, value] of [["2000-01-01T00:00:00Z", 0], ["2099-01-01T00:00:00Z", 1e100]]) {
    const response = await post({ recordedAt, powerKw: value, energyKwh: value, voltageV: value });
    assert.equal(response.status, 201);
  }
  assert.equal(await count(), 2);
});
integration("OpenAPI documents only implemented reading operations with public schemas and required headers", async () => {
  const spec = await (await fetch(`${origin}/openapi.json`)).json();
  const path = spec.paths["/installations/{installationId}/readings"];
  assert.deepEqual(Object.keys(path).sort(), ["get", "post"]);
  assert.deepEqual(path.post.security, [{ InstallationBearer: [] }]);
  for (const status of [201, 400, 401, 403, 406, 409, 413, 415, 429, 500]) assert.ok(path.post.responses[status]);
  for (const header of ["Location", "ETag", "Last-Modified"]) assert.ok(path.post.responses[201].headers[header]);
  assert.ok(path.post.responses[429].headers["Retry-After"]);
  assert.equal(spec.components.schemas.ReadingInput.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.ReadingInput.required, Object.keys(body));
  assert.deepEqual(Object.keys(spec.components.schemas.GenerationReading.properties).sort(), ["id", "installationId", "recordedAt", "receivedAt", "recordedAtDisplay", "receivedAtDisplay", "powerKw", "energyKwh", "voltageV"].sort());
  const individual = spec.paths["/installations/{installationId}/readings/{readingId}"];
  assert.deepEqual(Object.keys(individual), ["get"]);
  assert.deepEqual(individual.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(individual.get.parameters.filter(parameter => parameter.in === "path").map(parameter => parameter.name), ["installationId", "readingId"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(individual.get.responses[status]);
  assert.equal(individual.get.responses[304].content, undefined);
  for (const status of [200, 304]) {
    for (const header of ["ETag", "Last-Modified", "Cache-Control"]) assert.ok(individual.get.responses[status].headers[header]);
  }
  assert.deepEqual(path.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(path.get.parameters.filter(parameter => parameter.in === "query").map(parameter => parameter.name), ["offset", "limit", "from", "to", "sort"]);
  assert.equal(path.get.responses[200].headers["Last-Modified"], undefined);
  assert.equal(path.get.responses[304].content, undefined);
  const regional = spec.paths["/readings"];
  assert.deepEqual(Object.keys(regional), ["get"]);
  assert.deepEqual(regional.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(regional.get.parameters.filter(parameter => parameter.in === "query").map(parameter => parameter.name),
    ["provinceId", "districtId", "substationId", "offset", "limit", "from", "to", "sort"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(regional.get.responses[status]);
  assert.equal(regional.get.responses[304].content, undefined);
  assert.equal(regional.get.responses[200].headers["Last-Modified"], undefined);
});
integration("concurrent duplicate submissions commit exactly one reading", async () => {
  const responses = await Promise.all([post(), post()]);
  assert.deepEqual(responses.map(res => res.status).sort(), [201, 409]);
  assert.equal(await count(), 1);
});
integration("insertion failure rolls back the parent lock and returns a sanitized error", async t => {
  t.mock.method(models.GenerationReading.prototype, "save", async () => { throw new Error("private persistence failure"); });
  const response = await post();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(await count(), 0);
  assert.equal((await models.SolarInstallation.collection.findOne({ publicId: installationId }))._ingestionLock, undefined);
});
integration("installation rate counter independently rejects across client IP counters", async () => {
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `device-write-installation:${createHash("sha256").update(installationId).digest("hex")}`,
    count: 30, expiresAt: new Date(Date.now() + 60000) });
  const response = await post();
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(await count(), 0);
});
integration("shared installation and IP limits reject the 31st attempt with Retry-After", async () => {
  for (let i = 0; i < 30; i++) {
    const res = await post({ ...body, recordedAt: new Date(Date.UTC(2026, 9, 8, 0, i)).toISOString() });
    assert.equal(res.status, 201);
  }
  const res = await post();
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get("retry-after")) > 0);
  assert.equal((await res.json()).code, "RATE_LIMIT_EXCEEDED");
  assert.equal(await count(), 30);
  assert.equal(await Counter.countDocuments({ count: 30 }), 1);
  assert.equal(await Counter.countDocuments({ count: 31 }), 1);
});

integration("lifecycle committing first forces ingestion retry and active/existence recheck", async t => {
  for (const action of ["deactivate", "delete"]) {
    if (action === "delete") await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "active" } });
    let unlock, started;
    const gate = new Promise(resolve => { unlock = resolve; });
    const locked = new Promise(resolve => { started = resolve; });
    const lifecycle = mongoose.connection.transaction(async session => {
      await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } }, { session });
      started(); await gate;
      if (action === "delete") {
        assert.equal(await models.GenerationReading.countDocuments({ installationId }).session(session), 0);
        await models.SolarInstallation.deleteOne({ publicId: installationId }, { session });
      }
    });
    await locked;
    let attempted;
    const attempt = new Promise(resolve => { attempted = resolve; });
    const original = models.SolarInstallation.updateOne;
    const mock = t.mock.method(models.SolarInstallation, "updateOne", function (...args) {
      if (args[1].$set?._ingestionLock) attempted();
      return original.apply(this, args);
    });
    const submission = post();
    await attempt; unlock(); await lifecycle;
    assert.equal((await submission).status, action === "delete" ? 401 : 403);
    mock.mock.restore();
    assert.equal(await count(), 0);
  }
});
integration("ingestion committing first makes concurrent guarded deletion retain installation and history", async t => {
  let release, inserted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { inserted = resolve; });
  const original = models.GenerationReading.prototype.save;
  t.mock.method(models.GenerationReading.prototype, "save", async function (...args) {
    const result = await original.apply(this, args);
    inserted(); await gate; return result;
  });
  const ingestion = createReading(installationId, { ...body, recordedAt: new Date(body.recordedAt) });
  await ready;
  let attempted;
  const attempt = new Promise(resolve => { attempted = resolve; });
  const deletion = mongoose.connection.transaction(async session => {
    attempted();
    await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { _ingestionLock: randomUUID() } }, { session });
    if (await models.GenerationReading.exists({ installationId }).session(session)) {
      await models.SolarInstallation.updateOne({ publicId: installationId }, { $unset: { _ingestionLock: "" } }, { session });
      return 409;
    }
    await models.SolarInstallation.deleteOne({ publicId: installationId }, { session });
    return 204;
  });
  await attempt; release(); await ingestion;
  assert.equal(await deletion, 409);
  assert.equal(await count(), 1);
  assert.ok(await models.SolarInstallation.exists({ publicId: installationId }));
});

integration("single-reading GET serves all authorized scopes with POST-identical public JSON and validators, including inactive history", async () => {
  const created = await createdReading();
  const substation = await models.GridSubstation.findOne({});
  const district = await models.District.findOne({});
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: substation.districtId }]) {
    const { access } = await analyst(fields);
    for (const status of ["active", "inactive"]) {
      await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status } });
      const response = await read(created.body.id, access);
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, created.body);
      assert.equal(response.headers.etag, created.etag);
      assert.equal(response.headers["last-modified"], created.modified);
      assert.equal(response.headers["cache-control"], "private, no-cache");
      assert.equal(response.headers.location, undefined);
    }
  }
  assert.equal(await count(), 1);
});

integration("display timestamps handle Colombo date rollover, midnight and noon without altering stored instants", async () => {
  const recordedAt = new Date("2026-12-31T18:30:00.123Z");
  const receivedAt = new Date("2027-01-01T06:30:00.456Z");
  const record = await models.GenerationReading.create({ installationId, recordedAt, receivedAt, powerKw: 1, energyKwh: 2, voltageV: 230 });
  const { access } = await analyst();
  const response = await read(record.publicId, access);
  assert.equal(response.status, 200);
  assert.equal(response.body.recordedAtDisplay, "01 Jan 2027, 12:00 AM (Sri Lanka)");
  assert.equal(response.body.receivedAtDisplay, "01 Jan 2027, 12:00 PM (Sri Lanka)");
  assert.equal(response.body.recordedAt, "2027-01-01T00:00:00.123+05:30");
  assert.equal(response.body.receivedAt, "2027-01-01T12:00:00.456+05:30");
  assert.deepEqual((await list(access)).body.items, [response.body]);
  const stored = await models.GenerationReading.collection.findOne({ publicId: record.publicId });
  assert.equal(stored.recordedAt.getTime(), recordedAt.getTime());
  assert.equal(stored.receivedAt.getTime(), receivedAt.getTime());
  assert.equal(stored.recordedAtDisplay, undefined);
  assert.equal(stored.receivedAtDisplay, undefined);
});

integration("jurisdiction rejects with 403 before reading lookup; missing and mismatched identities return 404", async t => {
  const created = await createdReading();
  const localDistrict = await models.District.findOne({});
  const foreignProvince = await models.Province.create({ name: "Other province" });
  const foreignDistrict = await models.District.create({ name: "Other district", provinceId: foreignProvince.publicId });
  const sibling = await models.District.create({ name: "Sibling district", provinceId: localDistrict.provinceId });
  let lookups = 0;
  const original = models.GenerationReading.findOne;
  t.mock.method(models.GenerationReading, "findOne", function (...args) {
    lookups++; return original.apply(this, args);
  });
  const responses = [];
  for (const fields of [{ readScope: "province", provinceId: foreignProvince.publicId },
    { readScope: "district", districtId: foreignDistrict.publicId }, { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    const response = await read(created.body.id, access, installationId, { "If-None-Match": created.etag });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { code: "FORBIDDEN", message: "The installation is outside your permitted jurisdiction.", details: [] });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["last-modified"], undefined);
    assert.notEqual(response.headers.etag, created.etag);
    assert.equal((await read(randomUUID(), access)).status, 403);
  }
  assert.equal(lookups, 0);
  const { access } = await analyst();
  responses.push(await read(created.body.id, access, randomUUID()));
  responses.push(await read(randomUUID(), access));
  const station = await models.GridSubstation.findOne({});
  const otherInstallation = await models.SolarInstallation.create({ substationId: station.publicId, meterId: "OTHER-METER", deviceCredentialHash: "test-only-hash" });
  responses.push(await read(created.body.id, access, otherInstallation.publicId, { "If-None-Match": "*" }));
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { code: "NOT_FOUND", message: "Reading not found.", details: [] });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["last-modified"], undefined);
    assert.notEqual(response.headers.etag, created.etag);
  }
  assert.equal(await count(), 1);
});

integration("reading GET authenticates users and validates both UUIDs before resource/validator access", async () => {
  const created = await createdReading();
  for (const access of [null, "invalid", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    const response = await read(created.body.id, access, installationId, { "If-None-Match": "*" });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["last-modified"], undefined);
  }
  const { user, access } = await analyst();
  for (const [installation, reading] of [["invalid", created.body.id], [installationId, "invalid"],
    [installationId.replace(/^(.{14})4/, (_, prefix) => prefix + "1"), created.body.id]]) {
    const response = await read(reading, access, installation, { "If-None-Match": "*" });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_REQUEST");
  }
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await read(created.body.id, access)).status, 401);
  assert.equal(await count(), 1);
});

integration("reading conditional GET honors weak/list/wildcard ETags, HTTP dates, and ETag precedence", async () => {
  const created = await createdReading();
  const { access } = await analyst();
  const earlier = new Date(new Date(created.modified).getTime() - 1000).toUTCString();
  const future = new Date(new Date(created.modified).getTime() + 60000).toUTCString();
  for (const [headers, status] of [
    [{ "If-None-Match": created.etag }, 304], [{ "If-None-Match": `W/${created.etag}` }, 304],
    [{ "If-None-Match": `"other", ${created.etag}` }, 304], [{ "If-None-Match": "*" }, 304],
    [{ "If-Modified-Since": created.modified }, 304], [{ "If-Modified-Since": future }, 304],
    [{ "If-Modified-Since": earlier }, 200], [{ "If-Modified-Since": "invalid" }, 200],
    [{ "If-None-Match": created.etag, "If-Modified-Since": earlier }, 304],
    [{ "If-None-Match": '"other"', "If-Modified-Since": future }, 200],
  ]) {
    const response = await read(created.body.id, access, installationId, headers);
    assert.equal(response.status, status);
    assert.equal(response.headers.etag, created.etag);
    assert.equal(response.headers["last-modified"], created.modified);
    assert.equal(response.headers["cache-control"], "private, no-cache");
    if (status === 304) {
      assert.equal(response.text, "");
      assert.equal(response.headers["content-type"], undefined);
    }
  }
});

integration("stale user jurisdiction and shared read limits are checked before 304", async () => {
  const created = await createdReading();
  const { user, access } = await analyst();
  assert.equal((await read(created.body.id, access)).status, 200);
  const foreignProvince = await models.Province.create({ name: "Changed jurisdiction" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreignProvince.publicId } });
  assert.equal((await read(created.body.id, access, installationId, { "If-None-Match": created.etag })).status, 403);
  const { access: adminAccess, user: admin } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(admin.publicId).digest("hex")}`,
    count: 120, expiresAt: new Date(Date.now() + 60000) });
  const response = await read(created.body.id, adminAccess, installationId, { "If-None-Match": created.etag });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers["retry-after"]) > 0);
  assert.equal(response.body.code, "RATE_LIMIT_EXCEEDED");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["last-modified"], undefined);
  assert.equal(await count(), 1);
});

integration("broken installation ancestry fails closed for national reads", async () => {
  const created = await createdReading();
  const { access } = await analyst();
  for (const model of [models.Province, models.District, models.GridSubstation, models.SolarInstallation]) {
    const saved = await model.collection.findOne({});
    await model.collection.deleteOne({ _id: saved._id });
    const response = await read(created.body.id, access, installationId, { "If-None-Match": "*" });
    assert.equal(response.status, 404);
    assert.equal(response.headers["last-modified"], undefined);
    // Restore only this disposable fixture so every ancestry link is exercised.
    await model.collection.insertOne(saved);
  }
});

integration("reading persistence failures remain sanitized and non-cacheable", async t => {
  const created = await createdReading();
  const { access } = await analyst();
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("private diagnostics"); });
  const response = await read(created.body.id, access);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["last-modified"], undefined);
});

async function history(size = 6) {
  return models.GenerationReading.create(Array.from({ length: size }, (_, index) => ({
    installationId, recordedAt: new Date(Date.UTC(2026, 9, 8, 0, index)),
    receivedAt: new Date(Date.UTC(2026, 9, 8, 0, index, 5)), powerKw: index, energyKwh: index * 2, voltageV: 230,
  })));
}

integration("reading list filters before counting/paging, sorts deterministically and preserves links", async () => {
  const records = await history();
  const { access } = await analyst();
  const station = await models.GridSubstation.findOne({});
  const foreign = await models.SolarInstallation.create({ substationId: station.publicId, meterId: "OTHER-HISTORY", deviceCredentialHash: "test-hash" });
  await models.GenerationReading.create({ installationId: foreign.publicId, recordedAt: records[0].recordedAt, powerKw: 99, energyKwh: 99, voltageV: 230 });
  const defaultPage = await list(access);
  assert.equal(defaultPage.status, 200);
  assert.equal(defaultPage.body.count, 6);
  assert.deepEqual(defaultPage.body.items.map(item => item.id), records.map(record => record.publicId).reverse());
  assert.equal(defaultPage.headers["cache-control"], "private, no-cache");
  assert.equal(defaultPage.headers["last-modified"], undefined);
  const filters = new URLSearchParams({ from: "2026-10-08T05:31:00+05:30", to: "2026-10-08T05:35:00+05:30", sort: "timestamp", offset: "1", limit: "2" });
  const page = await list(access, `?${filters}`);
  assert.equal(page.body.count, 4);
  assert.deepEqual(page.body.items.map(item => item.id), [records[2].publicId, records[3].publicId]);
  for (const [key, offset] of [["next", "3"], ["previous", "0"]]) {
    const url = new URL(page.body[key], origin);
    assert.equal(url.pathname, `/api/v1.0/installations/${installationId}/readings`);
    for (const field of ["from", "to", "sort", "limit"]) assert.equal(url.searchParams.get(field), filters.get(field));
    assert.equal(url.searchParams.get("offset"), offset);
  }
  const next = await rawGet(page.body.next.replace("/api/v1.0", ""), access, {});
  assert.deepEqual(next.body.items.map(item => item.id), [records[4].publicId]);
  assert.equal(next.body.next, null);
  const reversed = await list(access, "?sort=-timestamp&limit=2&offset=1");
  assert.deepEqual(reversed.body.items.map(item => item.id), [records[4].publicId, records[3].publicId]);
  const single = await read(records[2].publicId, access);
  assert.deepEqual(page.body.items[0], single.body);
  assert.deepEqual(Object.keys(single.body).sort(), ["id", "installationId", "recordedAt", "receivedAt", "recordedAtDisplay", "receivedAtDisplay", "powerKw", "energyKwh", "voltageV"].sort());
  const outsidePage = await list(access, "?offset=99&limit=2");
  assert.equal(outsidePage.body.count, 6);
  assert.deepEqual(outsidePage.body.items, []);
  assert.equal(outsidePage.body.next, null);
});

integration("reading list applies default pagination and returns authorized empty/inactive history", async () => {
  const { access } = await analyst();
  assert.deepEqual((await list(access)).body, { count: 0, next: null, previous: null, items: [] });
  const records = await history(55);
  const initial = await list(access);
  assert.equal(initial.body.count, 55);
  assert.equal(initial.body.items.length, 50);
  assert.equal(new URL(initial.body.next, origin).searchParams.get("offset"), "50");
  const district = await models.District.findOne({});
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  for (const fields of [{ role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access: scoped } = await analyst(fields);
    const result = await list(scoped, "?limit=200");
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 55);
    assert.equal(result.body.items.length, 55);
  }
  const empty = await list(access, "?from=2099-01-01T00%3A00%3A00Z");
  assert.deepEqual(empty.body, { count: 0, next: null, previous: null, items: [] });
  assert.equal(await count(), records.length);
});

integration("reading list rejects invalid/repeated/unsupported queries and malformed UUIDs without validators", async () => {
  const { access } = await analyst();
  for (const query of ["?offset=-1", "?offset=1.5", "?offset=1e2", "?offset=", "?offset=9007199254740992", "?limit=0", "?limit=201", "?limit=abc", "?sort=powerKw", "?sort=", "?limit=1&limit=2", "?from=a&from=b", "?extra=1", "?provinceId=x", "?from=2026-02-30T00:00:00Z", "?from=2026-10-08", "?to=invalid", "?from=2026-10-08T00:00:00Z&to=2026-10-08T00:00:00Z", "?from=2026-10-09T00:00:00Z&to=2026-10-08T00:00:00Z"]) {
    const result = await list(access, query, installationId, { "If-None-Match": "*" });
    assert.equal(result.status, 400, query);
    assert.equal(result.body.code, "INVALID_QUERY");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  const invalidId = await list(access, "", "bad-id");
  assert.equal(invalidId.status, 400);
  assert.equal(invalidId.body.code, "INVALID_REQUEST");
  assert.equal(invalidId.headers.etag, undefined);
});

integration("reading list denied requests expose no readings, counts or validators and do not query history", async t => {
  await history();
  t.mock.method(models.GenerationReading, "find", () => { throw new Error("Denied request must not query history"); });
  t.mock.method(models.GenerationReading, "countDocuments", () => { throw new Error("Denied request must not count history"); });
  const denied = [];
  const unacceptable = await list(null, "", installationId, { Accept: "text/html" });
  assert.equal(unacceptable.status, 406);
  assert.equal(unacceptable.text, "");
  assert.equal(unacceptable.headers.etag, undefined);
  assert.equal(unacceptable.headers["cache-control"], "no-store");
  for (const access of [null, "invalid-token", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    denied.push([await list(access, "", installationId, { "If-None-Match": "*" }), 401]);
  }
  const otherProvince = await models.Province.create({ name: "Other scope" });
  const otherDistrict = await models.District.create({ name: "Other scope district", provinceId: otherProvince.publicId });
  const localDistrict = await models.District.findOne({ name: "Test district" });
  const sibling = await models.District.create({ name: "Sibling scope", provinceId: localDistrict.provinceId });
  for (const fields of [{ readScope: "province", provinceId: otherProvince.publicId },
    { readScope: "district", districtId: otherDistrict.publicId }, { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    denied.push([await list(access, "", installationId, { "If-None-Match": "*" }), 403]);
  }
  const { access, user } = await analyst();
  denied.push([await list(access, "", randomUUID()), 404]);
  const { createHash } = require("node:crypto");
  await Counter.updateOne({ _id: `user-read:${createHash("sha256").update(user.publicId).digest("hex")}` },
    { $set: { count: 120, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true });
  const limited = await list(access, "", installationId, { "If-None-Match": "*" });
  denied.push([limited, 429]);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  for (const [response, expected] of denied) {
    assert.equal(response.status, expected);
    assert.equal(response.body.items, undefined);
    assert.equal(response.body.count, undefined);
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["last-modified"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

integration("reading list ETags cover context, query and whole envelope, with authorization before conditional GET", async () => {
  await history();
  const { access, user } = await analyst();
  const first = await list(access, "?limit=1");
  const tag = first.headers.etag;
  assert.match(tag, /^"[0-9a-f]+"$/);
  for (const match of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const result = await list(access, "?limit=1", installationId, { "If-None-Match": match });
    assert.equal(result.status, 304);
    assert.equal(result.text, "");
    assert.equal(result.headers["content-type"], undefined);
    assert.equal(result.headers.etag, tag);
    assert.equal(result.headers["cache-control"], "private, no-cache");
  }
  const future = new Date(Date.now() + 86400000).toUTCString();
  assert.equal((await list(access, "?limit=1", installationId, { "If-Modified-Since": future })).status, 200);
  assert.equal((await list(access, "?limit=1", installationId, { "If-None-Match": '"other"', "If-Modified-Since": future })).status, 200);
  assert.notEqual((await list(access, "?limit=1&offset=1")).headers.etag, tag);
  assert.notEqual((await list(access, "?limit=1&sort=timestamp")).headers.etag, tag);
  const { access: otherAccess } = await analyst();
  assert.notEqual((await list(otherAccess, "?limit=1")).headers.etag, tag);
  // Insertion outside the displayed first page still changes the total and tag.
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2000-01-01T00:00:00Z"), powerKw: 1, energyKwh: 1, voltageV: 230 });
  const changed = await list(access, "?limit=1", installationId, { "If-None-Match": tag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.count, 7);
  assert.deepEqual(changed.body.items, first.body.items);
  assert.notEqual(changed.headers.etag, tag);
  const foreignProvince = await models.Province.create({ name: "New scope" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreignProvince.publicId } });
  const denied = await list(access, "?limit=1", installationId, { "If-None-Match": changed.headers.etag });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.etag, undefined);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await list(access)).status, 401);
});

integration("reading list keeps count and page in one snapshot during concurrent insertion", async t => {
  await history();
  const { access } = await analyst();
  const original = models.GenerationReading.countDocuments;
  const mock = t.mock.method(models.GenerationReading, "countDocuments", function (...args) {
    const query = original.apply(this, args);
    const execute = query.exec;
    query.exec = async function (...executionArgs) {
      const value = await execute.apply(this, executionArgs);
      await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-09T00:00:00Z"), powerKw: 1, energyKwh: 1, voltageV: 230 });
      return value;
    };
    return query;
  });
  const response = await list(access);
  mock.mock.restore();
  assert.equal(response.status, 200);
  assert.equal(response.body.count, 6);
  assert.equal(response.body.items.length, 6);
  const next = await list(access);
  assert.equal(next.body.count, 7);
  assert.equal(next.body.items.length, 7);
  assert.notEqual(next.headers.etag, response.headers.etag);
});

integration("reading list persistence errors remain sanitized without validators", async t => {
  const { access } = await analyst();
  t.mock.method(models.GenerationReading, "countDocuments", () => { throw new Error("private database diagnostics"); });
  const response = await list(access);
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers["last-modified"], undefined);
});

function regional(access, query = "", headers = {}) {
  return rawGet("/readings" + query, access, headers);
}
async function regionalFixture() {
  const local = await models.District.findOne({ name: "Test district" });
  const station = await models.GridSubstation.findOne({ districtId: local.publicId });
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  const foreignProvince = await models.Province.create({ name: "Foreign" });
  const foreign = await models.District.create({ name: "Foreign", provinceId: foreignProvince.publicId });
  const ids = [installationId];
  const stations = [station];
  for (const district of [sibling, foreign]) {
    const substation = await models.GridSubstation.create({ name: district.name, districtId: district.publicId });
    stations.push(substation);
    const installation = await models.SolarInstallation.create({ substationId: substation.publicId,
      meterId: randomUUID(), deviceCredentialHash: "fixture-hash", status: "inactive" });
    ids.push(installation.publicId);
  }
  const records = [];
  for (const id of ids) {
    for (let i = 0; i < 3; i++) records.push(await models.GenerationReading.create({ installationId: id,
      recordedAt: new Date(Date.UTC(2026, 9, 8, 0, i)), powerKw: i, energyKwh: i, voltageV: 230 }));
  }
  return { local, sibling, foreign, stations, ids, records };
}

integration("regional readings scope national, admin, province and district counts and retain inactive history", async () => {
  const f = await regionalFixture();
  for (const [fields, ids] of [[{}, f.ids], [{ role: "admin" }, f.ids],
    [{ readScope: "province", provinceId: f.local.provinceId }, f.ids.slice(0, 2)],
    [{ readScope: "district", districtId: f.local.publicId }, f.ids.slice(0, 1)]]) {
    const { access } = await analyst(fields);
    const result = await regional(access);
    assert.equal(result.status, 200);
    assert.equal(result.body.count, ids.length * 3);
    assert.deepEqual([...new Set(result.body.items.map(item => item.installationId))].sort(), ids.slice().sort());
    const expected = f.records.filter(r => ids.includes(r.installationId)).sort((a, b) =>
      b.recordedAt - a.recordedAt || (a.publicId < b.publicId ? 1 : -1));
    assert.deepEqual(result.body.items.map(item => item.id), expected.map(r => r.publicId));
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
    assert.deepEqual(Object.keys(result.body.items[0]).sort(), ["id", "installationId", "recordedAt", "receivedAt",
      "recordedAtDisplay", "receivedAtDisplay", "powerKw", "energyKwh", "voltageV"].sort());
  }
  const { access } = await analyst({ readScope: "district", districtId: f.local.publicId });
  assert.equal((await regional(access, "?provinceId=" + f.local.provinceId)).body.count, 3);
  assert.equal((await regional(access, "?from=2099-01-01T00:00:00Z")).body.count, 0);
  assert.equal(await count(), 9);
});

integration("regional filters, exclusive time bounds, deterministic ties and pagination links are shared", async () => {
  const f = await regionalFixture();
  const { access } = await analyst();
  for (const [key, id, expected] of [["provinceId", f.local.provinceId, 6], ["districtId", f.sibling.publicId, 3],
    ["substationId", f.stations[2].publicId, 3]]) {
    assert.equal((await regional(access, "?" + key + "=" + id)).body.count, expected);
  }
  const query = new URLSearchParams({ provinceId: f.local.provinceId, districtId: f.local.publicId,
    substationId: f.stations[0].publicId, from: "2026-10-08T05:30:00+05:30", to: "2026-10-08T05:32:00+05:30",
    sort: "timestamp", limit: "1", offset: "1" });
  const result = await regional(access, "?" + query);
  assert.equal(result.body.count, 2);
  assert.equal(result.body.items[0].recordedAt, "2026-10-08T05:31:00.000+05:30");
  const previous = new URL(result.body.previous, origin);
  assert.equal(previous.pathname, "/api/v1.0/readings");
  for (const [key, value] of query) assert.equal(previous.searchParams.get(key), key === "offset" ? "0" : value);
  const first = await regional(access, "?limit=2&sort=timestamp");
  const tied = f.records.filter(r => r.recordedAt.getUTCMinutes() === 0).map(r => r.publicId).sort();
  assert.deepEqual(first.body.items.map(item => item.id), tied.slice(0, 2));
  assert.equal(first.body.count, 9);
  const next = new URL(first.body.next, origin);
  assert.equal(next.searchParams.get("offset"), "2");
  assert.equal(next.searchParams.get("sort"), "timestamp");
  assert.equal((await regional(access, "?offset=99")).body.items.length, 0);
});

integration("regional filter errors authorize before history queries and never expose data or validators", async t => {
  const f = await regionalFixture();
  t.mock.method(models.GenerationReading, "find", () => { throw new Error("Denied request queried readings"); });
  t.mock.method(models.GenerationReading, "countDocuments", () => { throw new Error("Denied request counted readings"); });
  const { access } = await analyst();
  const { access: provincial } = await analyst({ readScope: "province", provinceId: f.local.provinceId });
  const { access: district } = await analyst({ readScope: "district", districtId: f.local.publicId });
  const requests = [[null, "", 401], ["bad-token", "", 401], [token(), "", 401],
    [token({ actor: "user" }, { expiresIn: -1 }), "", 401],
    [provincial, "?provinceId=" + f.foreign.provinceId, 403],
    [provincial, "?districtId=" + f.foreign.publicId, 403],
    [district, "?districtId=" + f.sibling.publicId, 403],
    [district, "?substationId=" + f.stations[1].publicId, 403],
    [access, "?provinceId=" + randomUUID(), 404], [access, "?districtId=" + randomUUID(), 404],
    [access, "?substationId=" + randomUUID(), 404],
    [access, "?provinceId=" + f.local.provinceId + "&districtId=" + f.foreign.publicId, 400],
    [access, "?districtId=" + f.local.publicId + "&substationId=" + f.stations[1].publicId, 400]];
  for (const query of ["?provinceId=bad", "?districtId=bad", "?substationId=bad", "?provinceId=x&provinceId=y",
    "?installationId=" + installationId, "?offset=-1", "?offset=1.2", "?offset=9007199254740992", "?limit=0", "?limit=201",
    "?limit=1&limit=2", "?sort=other", "?from=2026-02-30T00:00:00Z", "?to=bad", "?from=2026-10-08T00:00:00Z&to=2026-10-08T00:00:00Z"])
    requests.push([access, query, 400]);
  for (const [auth, query, status] of requests) {
    const result = await regional(auth, query, { "If-None-Match": "*" });
    assert.equal(result.status, status, query);
    assert.equal(result.body.items, undefined);
    assert.equal(result.body.count, undefined);
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
    assert.equal(result.headers["cache-control"], "no-store");
  }
});

integration("regional cache validators reflect scoped context and full envelope after fresh authentication and limiting", async () => {
  const f = await regionalFixture();
  const { access, user } = await analyst();
  const first = await regional(access, "?limit=1");
  for (const tag of [first.headers.etag, "W/" + first.headers.etag, '"other", ' + first.headers.etag, "*"]) {
    const cached = await regional(access, "?limit=1", { "If-None-Match": tag });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.headers["content-type"], undefined);
  }
  assert.equal((await regional(access, "?limit=1", { "If-Modified-Since": new Date().toUTCString() })).status, 200);
  assert.notEqual((await regional(access, "?limit=2")).headers.etag, first.headers.etag);
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2000-01-01T00:00:00Z"), powerKw: 0, energyKwh: 0, voltageV: 230 });
  const changed = await regional(access, "?limit=1", { "If-None-Match": first.headers.etag });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.items, first.body.items);
  assert.equal(changed.body.count, 10);
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "district", districtId: f.local.publicId } });
  const scoped = await regional(access, "?limit=1", { "If-None-Match": changed.headers.etag });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.count, 4);
  const denied = await regional(access, "?districtId=" + f.foreign.publicId, { "If-None-Match": "*" });
  assert.equal(denied.status, 403);
  const { createHash } = require("node:crypto");
  await Counter.updateOne({ _id: "user-read:" + createHash("sha256").update(user.publicId).digest("hex") },
    { $set: { count: 120, expiresAt: new Date(Date.now() + 60000) } });
  const limited = await regional(access, "?limit=1", { "If-None-Match": scoped.headers.etag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await regional(access)).status, 401);
});

integration("regional list uses a single snapshot and fails closed on broken ancestry and database errors", async t => {
  await history(2);
  const { access } = await analyst();
  const original = models.GenerationReading.countDocuments;
  let inserted = false;
  t.mock.method(models.GenerationReading, "countDocuments", function (...args) {
    const query = original.apply(this, args);
    const exec = query.exec;
    query.exec = async function (...args) {
      const total = await exec.apply(this, args);
      if (!inserted) {
        inserted = true;
        await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-08T00:02:00Z"), powerKw: 2, energyKwh: 2, voltageV: 230 });
      }
      return total;
    };
    return query;
  });
  const snapshot = await regional(access);
  assert.equal(snapshot.body.count, 2);
  assert.equal(snapshot.body.items.length, 2);
  assert.equal(await count(), 3);
  t.mock.restoreAll();
  const province = await models.Province.findOne({});
  await models.Province.collection.deleteOne({ publicId: province.publicId });
  assert.deepEqual((await regional(access)).body, { count: 0, next: null, previous: null, items: [] });
  const missing = await regional(access, "?provinceId=" + province.publicId);
  assert.equal(missing.status, 404);
  t.mock.method(models.Province, "find", () => { throw new Error("private diagnostics"); });
  const failed = await regional(access);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INTERNAL_SERVER_ERROR");
  assert.equal(failed.headers.etag, undefined);
  assert.ok(!failed.text.includes("private diagnostics"));
});

function lastReading(access, id = installationId, headers = {}) {
  return rawGet(`/installations/${id}/last-reading`, access, headers);
}

integration("last-reading selects recordedAt over receivedAt, shares public representation and permits every scope on inactive sites", async () => {
  const records = await history(2);
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-07T00:00:00Z"),
    receivedAt: new Date("2026-10-09T00:00:00Z"), powerKw: 99, energyKwh: 99, voltageV: 230 });
  const district = await models.District.findOne({});
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access } = await analyst(fields);
    const response = await lastReading(access);
    const individual = await read(records[1].publicId, access);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, individual.body);
    assert.equal(response.headers.etag, individual.headers.etag);
    assert.equal(response.headers["last-modified"], records[1].receivedAt.toUTCString());
    assert.equal(response.headers["cache-control"], "private, no-cache");
  }
});

integration("last-reading rejects wrong actors, invalid UUIDs, missing installations, empty history and broken ancestry before validators", async () => {
  for (const access of [null, "invalid", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    const response = await lastReading(access, installationId, { "If-None-Match": "*" });
    assert.equal(response.status, 401);
    assert.equal(response.headers["www-authenticate"], "Bearer");
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["last-modified"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const { access } = await analyst();
  assert.equal((await lastReading(access, "invalid")).status, 400);
  for (const id of [installationId, randomUUID()]) {
    const response = await lastReading(access, id, { "If-None-Match": "*" });
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { code: "NOT_FOUND", message: "Reading not found.", details: [] });
    assert.equal(response.headers.etag, undefined);
  }
  await history(1);
  await models.Province.collection.deleteMany({});
  assert.equal((await lastReading(access, installationId, { "If-None-Match": "*" })).status, 404);
});

integration("last-reading forbids foreign provinces and sibling districts before querying even empty history", async t => {
  const local = await models.District.findOne({});
  const foreign = await models.Province.create({ name: "Foreign" });
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("Reading query must not run"); });
  for (const fields of [{ readScope: "province", provinceId: foreign.publicId },
    { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    const response = await lastReading(access, installationId, { "If-None-Match": "*" });
    assert.equal(response.status, 403);
    assert.equal(response.body.code, "FORBIDDEN");
    assert.equal(response.headers.etag, undefined);
    assert.equal(response.headers["last-modified"], undefined);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

integration("last-reading conditional GET is bodyless, honors precedence and changes only for newer measurements", async () => {
  await history(1);
  const { access } = await analyst();
  const current = await lastReading(access);
  const tag = current.headers.etag;
  const modified = current.headers["last-modified"];
  const earlier = new Date(Date.parse(modified) - 1000).toUTCString();
  const future = new Date(Date.parse(modified) + 60000).toUTCString();
  for (const [headers, status] of [
    [{ "If-None-Match": tag }, 304], [{ "If-None-Match": `W/${tag}` }, 304],
    [{ "If-None-Match": `"other", ${tag}` }, 304], [{ "If-None-Match": "*" }, 304],
    [{ "If-Modified-Since": modified }, 304], [{ "If-Modified-Since": future }, 304],
    [{ "If-Modified-Since": earlier }, 200], [{ "If-Modified-Since": "invalid" }, 200],
    [{ "If-None-Match": tag, "If-Modified-Since": earlier }, 304],
    [{ "If-None-Match": '"other"', "If-Modified-Since": future }, 200],
  ]) {
    const response = await lastReading(access, installationId, headers);
    assert.equal(response.status, status);
    assert.equal(response.headers.etag, tag);
    assert.equal(response.headers["last-modified"], modified);
    if (status === 304) {
      assert.equal(response.text, "");
      assert.equal(response.headers["content-type"], undefined);
    }
  }
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-07T00:00:00Z"),
    receivedAt: new Date("2026-10-09T00:00:00Z"), powerKw: 4, energyKwh: 8, voltageV: 230 });
  assert.equal((await lastReading(access, installationId, { "If-None-Match": tag })).status, 304);
  const newer = await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-08T01:00:00Z"),
    receivedAt: new Date("2026-10-09T01:00:00Z"), powerKw: 5, energyKwh: 10, voltageV: 230 });
  const changed = await lastReading(access, installationId, { "If-None-Match": tag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.id, newer.publicId);
  assert.notEqual(changed.headers.etag, tag);
});

integration("last-reading reloads stored access and shares user limits before 304; persistence errors are sanitized", async t => {
  await history(1);
  const { user, access } = await analyst();
  const tag = (await lastReading(access)).headers.etag;
  const foreign = await models.Province.create({ name: "New assignment" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreign.publicId } });
  assert.equal((await lastReading(access, installationId, { "If-None-Match": tag })).status, 403);
  const { user: admin, access: adminAccess } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(admin.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await list(adminAccess)).status, 200);
  const limited = await lastReading(adminAccess, installationId, { "If-None-Match": tag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  assert.equal(limited.headers["last-modified"], undefined);
  const { access: otherAccess } = await analyst();
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("private diagnostics"); });
  const failed = await lastReading(otherAccess);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI last-reading uses user security, public reading schema and bodyless conditional responses", () => {
  const spec = require("../docs/openapi.json");
  const operation = spec.paths["/installations/{installationId}/last-reading"].get;
  assert.deepEqual(operation.security, [{ UserBearer: [] }]);
  assert.deepEqual(operation.parameters.filter(p => p.in === "path").map(p => p.name), ["installationId"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(operation.responses[status]);
  assert.equal(operation.responses[200].content["application/json"].schema.$ref, "#/components/schemas/GenerationReading");
  assert.equal(operation.responses[304].content, undefined);
  for (const status of [200, 304]) for (const name of ["ETag", "Last-Modified", "Cache-Control"]) assert.ok(operation.responses[status].headers[name]);
});

function overview(access, id = installationId, headers = {}) {
  return rawGet(`/installations/${id}/overview`, access, headers);
}

integration("overview returns the exact public composite for all authorized scopes, empty and inactive installations", async () => {
  const station = await models.GridSubstation.findOne({});
  const district = await models.District.findOne({});
  const province = await models.Province.findOne({});
  const expected = {
    installation: { id: installationId, substationId: station.publicId, meterId: "TEST-METER", status: "active" },
    geography: {
      province: { id: province.publicId, name: province.name },
      district: { id: district.publicId, provinceId: province.publicId, name: district.name },
      gridSubstation: { id: station.publicId, districtId: district.publicId, name: station.name },
    },
    latestReading: null,
  };
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: province.publicId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access } = await analyst(fields);
    const result = await overview(access);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, expected);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
  const readings = await history(2);
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-07T00:00:00Z"),
    receivedAt: new Date("2026-10-09T00:00:00Z"), powerKw: 99, energyKwh: 99, voltageV: 230 });
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  const { access } = await analyst();
  expected.installation.status = "inactive";
  expected.latestReading = (await read(readings[1].publicId, access)).body;
  const result = await overview(access);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, expected);
  for (const field of ["_id", "publicId", "__v", "deviceCredentialHash", "_ingestionLock", "passwordHash", "items"]) {
    assert.equal(result.text.includes(`"${field}"`), false);
  }
});

integration("overview rejects installation tokens and invalid UUIDs, returns 404 for missing ancestry, and hides error validators", async () => {
  for (const access of [null, "invalid", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    const result = await overview(access, installationId, { "If-None-Match": "*" });
    assert.equal(result.status, 401);
    assert.equal(result.headers["www-authenticate"], "Bearer");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
  }
  const { access } = await analyst();
  assert.equal((await overview(access, "invalid")).status, 400);
  const missing = await overview(access, randomUUID(), { "If-None-Match": "*" });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { code: "NOT_FOUND", message: "Installation not found.", details: [] });
  assert.equal(missing.headers.etag, undefined);
  for (const model of [models.Province, models.District, models.GridSubstation]) {
    const record = await model.collection.findOne({});
    await model.collection.deleteOne({ _id: record._id });
    assert.equal((await overview(access, installationId, { "If-None-Match": "*" })).status, 404);
    await model.collection.insertOne(record);
  }
});

integration("overview rejects foreign provinces and sibling districts before latest-reading queries or 304", async t => {
  const local = await models.District.findOne({});
  const province = await models.Province.create({ name: "Foreign province" });
  const foreign = await models.District.create({ name: "Foreign district", provinceId: province.publicId });
  const sibling = await models.District.create({ name: "Sibling district", provinceId: local.provinceId });
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("Forbidden reading lookup"); });
  for (const fields of [{ readScope: "province", provinceId: province.publicId },
    { readScope: "district", districtId: foreign.publicId }, { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    const result = await overview(access, installationId, { "If-None-Match": "*" });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, "FORBIDDEN");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("overview ETags cover the whole composite with bodyless 304 and no unreliable Last-Modified", async () => {
  const { access } = await analyst();
  let current = await overview(access);
  for (const value of [current.headers.etag, `W/${current.headers.etag}`, `"other", ${current.headers.etag}`, "*"]) {
    const cached = await overview(access, installationId, { "If-None-Match": value });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.headers["content-type"], undefined);
    assert.equal(cached.headers["last-modified"], undefined);
    assert.equal(cached.headers.etag, current.headers.etag);
    assert.equal(cached.headers["cache-control"], "private, no-cache");
  }
  const future = new Date("2099-01-01T00:00:00Z").toUTCString();
  assert.equal((await overview(access, installationId, { "If-Modified-Since": future })).status, 200);
  assert.equal((await overview(access, installationId, { "If-None-Match": '"other"', "If-Modified-Since": future })).status, 200);
  async function changed() {
    const result = await overview(access, installationId, { "If-None-Match": current.headers.etag });
    assert.equal(result.status, 200);
    assert.notEqual(result.headers.etag, current.headers.etag);
    current = result;
    return result;
  }
  await history(2);
  assert.ok((await changed()).body.latestReading);
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-08T01:00:00Z"),
    receivedAt: new Date("2026-10-08T01:00:01Z"), powerKw: 8, energyKwh: 16, voltageV: 230 });
  assert.equal((await changed()).body.latestReading.powerKw, 8);
  await models.GenerationReading.create({ installationId, recordedAt: new Date("2026-10-07T00:00:00Z"),
    receivedAt: new Date("2026-10-09T00:00:00Z"), powerKw: 9, energyKwh: 18, voltageV: 230 });
  assert.equal((await overview(access, installationId, { "If-None-Match": current.headers.etag })).status, 304);
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  assert.equal((await changed()).body.installation.status, "inactive");
  for (const [model, field] of [[models.Province, "province"], [models.District, "district"], [models.GridSubstation, "gridSubstation"]]) {
    await model.updateOne({}, { $set: { name: "Renamed" } });
    assert.equal((await changed()).body.geography[field].name, "Renamed");
  }
  const { access: otherAccess } = await analyst();
  assert.notEqual((await overview(otherAccess)).headers.etag, current.headers.etag);
});

integration("overview checks current stored access and shared rate limits before 304, and sanitizes failures", async t => {
  const { user, access } = await analyst();
  const tag = (await overview(access)).headers.etag;
  const province = await models.Province.create({ name: "Changed assignment" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: province.publicId } });
  assert.equal((await overview(access, installationId, { "If-None-Match": tag })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await overview(access, installationId, { "If-None-Match": tag })).status, 401);
  const { user: admin, access: adminAccess } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(admin.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await list(adminAccess)).status, 200);
  const limited = await overview(adminAccess, installationId, { "If-None-Match": tag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  const { access: another } = await analyst();
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("private diagnostics"); });
  const failed = await overview(another);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

integration("overview snapshot prevents mixing installation and latest reading states during concurrent changes", async t => {
  const records = await history(1);
  const { access } = await analyst();
  const original = models.GenerationReading.findOne;
  let changed = false;
  const mock = t.mock.method(models.GenerationReading, "findOne", function (...args) {
    const query = original.apply(this, args);
    const execute = query.exec;
    query.exec = async function (...options) {
      if (!changed) {
        changed = true;
        // Raw writes affect only this disposable local fixture, outside the read snapshot.
        await models.SolarInstallation.collection.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
        await models.GenerationReading.collection.insertOne({ publicId: randomUUID(), installationId,
          recordedAt: new Date("2026-10-08T01:00:00Z"), receivedAt: new Date("2026-10-08T01:00:01Z"),
          powerKw: 9, energyKwh: 18, voltageV: 230 });
      }
      return execute.apply(this, options);
    };
    return query;
  });
  const result = await overview(access);
  assert.equal(result.status, 200);
  assert.equal(result.body.installation.status, "active");
  assert.equal(result.body.latestReading.id, records[0].publicId);
  mock.mock.restore();
  const refreshed = await overview(access);
  assert.equal(refreshed.body.installation.status, "inactive");
  assert.equal(refreshed.body.latestReading.powerKw, 9);
  assert.notEqual(refreshed.headers.etag, result.headers.etag);
});

test("OpenAPI overview documents the composite, null readings and conditional responses without Last-Modified", () => {
  const spec = require("../docs/openapi.json");
  const operation = spec.paths["/installations/{installationId}/overview"].get;
  assert.deepEqual(operation.security, [{ UserBearer: [] }]);
  assert.deepEqual(operation.parameters.filter(p => p.in === "path").map(p => p.name), ["installationId"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(operation.responses[status]);
  assert.equal(operation.responses[200].content["application/json"].schema.$ref, "#/components/schemas/InstallationOverview");
  assert.equal(operation.responses[304].content, undefined);
  for (const status of [200, 304]) {
    assert.equal(operation.responses[status].headers["Last-Modified"], undefined);
    assert.ok(operation.responses[status].headers.ETag);
    assert.ok(operation.responses[status].headers["Cache-Control"]);
  }
  const schema = spec.components.schemas.InstallationOverview;
  assert.deepEqual(schema.required, ["installation", "geography", "latestReading"]);
  assert.equal(schema.properties.latestReading.nullable, true);
  assert.equal(schema.additionalProperties, false);
});

function installationDetails(access, id = installationId, headers = {}) {
  return rawGet(`/installations/${id}`, access, headers);
}

integration("installation details share exact public metadata and canonical strong ETags across all authorized readers, active and inactive", async () => {
  const station = await models.GridSubstation.findOne({});
  const district = await models.District.findOne({});
  const { createHash } = require("node:crypto");
  for (const status of ["active", "inactive"]) {
    await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status } });
    const expected = { id: installationId, substationId: station.publicId, meterId: "TEST-METER", status };
    const tag = `"${createHash("sha256").update(JSON.stringify(expected)).digest("hex")}"`;
    for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
      { readScope: "district", districtId: district.publicId }]) {
      const { access } = await analyst(fields);
      const result = await installationDetails(access);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, expected);
      assert.deepEqual(Object.keys(result.body), ["id", "substationId", "meterId", "status"]);
      assert.equal(result.headers.etag, tag);
      assert.match(tag, /^"[0-9a-f]{64}"$/);
      assert.equal(result.headers["cache-control"], "private, no-cache");
      assert.equal(result.headers["last-modified"], undefined);
      assert.deepEqual((await overview(access)).body.installation, result.body);
    }
  }
});

integration("installation details authenticate user actors, validate public IDs, and fail closed for missing installations or ancestry", async () => {
  for (const access of [null, "invalid", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    const result = await installationDetails(access, installationId, { "If-None-Match": "*" });
    assert.equal(result.status, 401);
    assert.equal(result.headers["www-authenticate"], "Bearer");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
  }
  const { access } = await analyst();
  for (const id of ["invalid", "507f1f77bcf86cd799439011", installationId.replace(/^(.{14})4/, (_, prefix) => prefix + "1")]) {
    const result = await installationDetails(access, id, { "If-None-Match": "*" });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_REQUEST");
    assert.equal(result.headers.etag, undefined);
  }
  const missing = await installationDetails(access, randomUUID(), { "If-None-Match": "*" });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { code: "NOT_FOUND", message: "Installation not found.", details: [] });
  assert.equal(missing.headers.etag, undefined);
  for (const model of [models.Province, models.District, models.GridSubstation]) {
    const saved = await model.collection.findOne({});
    await model.collection.deleteOne({ _id: saved._id });
    const result = await installationDetails(access, installationId, { "If-None-Match": "*" });
    assert.equal(result.status, 404);
    assert.equal(result.headers.etag, undefined);
    await model.collection.insertOne(saved);
  }
});

integration("installation detail jurisdiction rejects foreign provinces and sibling districts before returning data or validators", async () => {
  const { access: nationalAccess } = await analyst();
  const tag = (await installationDetails(nationalAccess)).headers.etag;
  const district = await models.District.findOne({});
  const foreignProvince = await models.Province.create({ name: "Foreign" });
  const foreignDistrict = await models.District.create({ name: "Foreign", provinceId: foreignProvince.publicId });
  const sibling = await models.District.create({ name: "Sibling", provinceId: district.provinceId });
  for (const fields of [{ readScope: "province", provinceId: foreignProvince.publicId },
    { readScope: "district", districtId: foreignDistrict.publicId }, { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    const result = await installationDetails(access, installationId, { "If-None-Match": tag });
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { code: "FORBIDDEN", message: "The installation is outside your permitted jurisdiction.", details: [] });
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("installation conditional GET is bodyless and ETags ignore readings/private metadata but track public status", async t => {
  const { access } = await analyst();
  const first = await installationDetails(access);
  const tag = first.headers.etag;
  const future = new Date("2099-01-01T00:00:00Z").toUTCString();
  for (const value of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const result = await installationDetails(access, installationId, { "If-None-Match": value });
    assert.equal(result.status, 304);
    assert.equal(result.text, "");
    assert.equal(result.headers["content-type"], undefined);
    assert.equal(result.headers.etag, tag);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
  assert.equal((await installationDetails(access, installationId, { "If-Modified-Since": future })).status, 200);
  assert.equal((await installationDetails(access, installationId, { "If-None-Match": '"other"', "If-Modified-Since": future })).status, 200);
  await history(2);
  await models.Province.updateOne({}, { $set: { name: "Renamed" } });
  // Only isolated fixture metadata changes; no installation-write endpoint is added.
  await models.SolarInstallation.collection.updateOne({ publicId: installationId },
    { $set: { deviceCredentialHash: "changed-test-hash", _ingestionLock: randomUUID(), __v: 99 } });
  t.mock.method(models.GenerationReading, "findOne", () => { throw new Error("Installation details must not query readings"); });
  const unchanged = await installationDetails(access, installationId, { "If-None-Match": tag });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.etag, tag);
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  const changed = await installationDetails(access, installationId, { "If-None-Match": tag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.status, "inactive");
  assert.notEqual(changed.headers.etag, tag);
  assert.deepEqual(Object.keys(changed.body), ["id", "substationId", "meterId", "status"]);
  await models.SolarInstallation.updateOne({ publicId: installationId }, { $set: { status: "inactive" } });
  assert.equal((await installationDetails(access)).headers.etag, changed.headers.etag);
});

integration("installation details recheck current user jurisdiction and shared read limits before 304 and sanitize failures", async t => {
  const { user, access } = await analyst();
  const tag = (await installationDetails(access)).headers.etag;
  const foreign = await models.Province.create({ name: "New assignment" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreign.publicId } });
  assert.equal((await installationDetails(access, installationId, { "If-None-Match": tag })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await installationDetails(access, installationId, { "If-None-Match": tag })).status, 401);
  const { user: admin, access: adminAccess } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(admin.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await overview(adminAccess)).status, 200);
  const limited = await installationDetails(adminAccess, installationId, { "If-None-Match": tag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  const { access: another } = await analyst();
  t.mock.method(models.SolarInstallation, "findOne", () => { throw new Error("private diagnostics"); });
  const failed = await installationDetails(another);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI installation details document public metadata, strong validators and GET only", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths["/installations/{installationId}"];
  assert.deepEqual(Object.keys(resource), ["get"]);
  assert.deepEqual(resource.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(resource.get.parameters.filter(p => p.in === "path").map(p => p.name), ["installationId"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[200].content["application/json"].schema.$ref, "#/components/schemas/SolarInstallation");
  assert.equal(resource.get.responses[304].content, undefined);
  for (const status of [200, 304]) {
    assert.equal(resource.get.responses[status].headers["Last-Modified"], undefined);
    assert.equal(resource.get.responses[status].headers.ETag.$ref, "#/components/headers/InstallationETag");
  }
  assert.deepEqual(Object.keys(spec.components.schemas.SolarInstallation.properties), ["id", "substationId", "meterId", "status"]);
  assert.equal(spec.components.schemas.SolarInstallation.additionalProperties, false);
});

function installations(access, query = "", headers = {}) {
  return rawGet("/installations" + query, access, headers);
}
async function installationListFixture() {
  const local = await models.District.findOne({ name: "Test district" });
  const station = await models.GridSubstation.findOne({ districtId: local.publicId });
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  const foreignProvince = await models.Province.create({ name: "Foreign" });
  const foreign = await models.District.create({ name: "Foreign", provinceId: foreignProvince.publicId });
  const stations = [station];
  for (const district of [sibling, foreign]) stations.push(await models.GridSubstation.create({ name: district.name, districtId: district.publicId }));
  const records = [await models.SolarInstallation.findOne({ publicId: installationId })];
  for (const substation of stations) {
    for (let index = 0; index < 2; index++) records.push(await models.SolarInstallation.create({
      substationId: substation.publicId, meterId: randomUUID(), deviceCredentialHash: "fixture-hash", status: index ? "inactive" : "active",
    }));
  }
  return { local, sibling, foreign, stations, records };
}

integration("installation lists isolate national/admin/province/district results and expose only public fields with both statuses", async () => {
  const f = await installationListFixture();
  for (const [fields, stations] of [[{}, f.stations], [{ role: "admin" }, f.stations],
    [{ readScope: "province", provinceId: f.local.provinceId }, f.stations.slice(0, 2)],
    [{ readScope: "district", districtId: f.local.publicId }, f.stations.slice(0, 1)]]) {
    const ids = stations.map(s => s.publicId);
    const expected = f.records.filter(r => ids.includes(r.substationId)).map(r => r.publicId).sort();
    const { access } = await analyst(fields);
    const result = await installations(access);
    assert.equal(result.status, 200);
    assert.equal(result.body.count, expected.length);
    assert.deepEqual(result.body.items.map(r => r.id), expected);
    assert.equal(result.body.next, null);
    assert.equal(result.body.previous, null);
    assert.ok(result.body.items.some(r => r.status === "inactive"));
    for (const item of result.body.items) assert.deepEqual(Object.keys(item), ["id", "substationId", "meterId", "status"]);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
  const { access } = await analyst({ readScope: "district", districtId: f.local.publicId });
  assert.equal((await installations(access, `?provinceId=${f.local.provinceId}`)).body.count, 3);
});

integration("installation geography filters narrow before count/page and pagination preserves filters and public-ID order", async () => {
  const f = await installationListFixture();
  const { access } = await analyst();
  for (const [query, expected] of [[`?provinceId=${f.local.provinceId}`, 5], [`?districtId=${f.sibling.publicId}`, 2],
    [`?substationId=${f.stations[2].publicId}`, 2]]) {
    assert.equal((await installations(access, query)).body.count, expected);
  }
  const params = new URLSearchParams({ provinceId: f.local.provinceId, districtId: f.local.publicId,
    substationId: f.stations[0].publicId, offset: "1", limit: "1" });
  const result = await installations(access, "?" + params);
  const expected = f.records.filter(r => r.substationId === f.stations[0].publicId).map(r => r.publicId).sort();
  assert.equal(result.body.count, 3);
  assert.deepEqual(result.body.items.map(r => r.id), expected.slice(1, 2));
  for (const [key, offset] of [["next", "2"], ["previous", "0"]]) {
    const url = new URL(result.body[key], origin);
    assert.equal(url.pathname, "/api/v1.0/installations");
    for (const filter of ["provinceId", "districtId", "substationId", "limit"]) assert.equal(url.searchParams.get(filter), params.get(filter));
    assert.equal(url.searchParams.get("offset"), offset);
  }
  const beyond = await installations(access, "?offset=99&limit=1");
  assert.equal(beyond.body.count, 7);
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.next, null);
  // Check documented defaults and bounds with more than one default page.
  await models.SolarInstallation.create(Array.from({ length: 51 }, () => ({ substationId: f.stations[0].publicId,
    meterId: randomUUID(), deviceCredentialHash: "fixture-hash" })));
  const defaultPage = await installations(access);
  assert.equal(defaultPage.body.count, 58);
  assert.equal(defaultPage.body.items.length, 50);
  assert.equal(new URL(defaultPage.body.next, origin).searchParams.get("offset"), "50");
  assert.equal((await installations(access, "?limit=200")).body.items.length, 58);
});

integration("installation lists reject actors and invalid/missing/forbidden/contradictory filters before installation queries", async t => {
  const f = await installationListFixture();
  t.mock.method(models.SolarInstallation, "find", () => { throw new Error("Unexpected installation query"); });
  t.mock.method(models.SolarInstallation, "countDocuments", () => { throw new Error("Unexpected installation count"); });
  for (const access of [null, "invalid", token()]) {
    const result = await installations(access, "", { "If-None-Match": "*" });
    assert.equal(result.status, 401);
    assert.equal(result.headers["www-authenticate"], "Bearer");
    assert.equal(result.headers.etag, undefined);
  }
  const { access } = await analyst();
  const cases = [];
  for (const query of ["?offset=-1", "?offset=1.5", "?offset=", "?offset=9007199254740991&limit=1", "?limit=0", "?limit=201",
    "?limit=1&limit=2", "?provinceId=x", "?districtId=bad", "?substationId=bad", "?status=active", "?sort=timestamp", "?from=2026-10-08", "?to=bad", "?extra=x"])
    cases.push([access, query, 400]);
  for (const key of ["provinceId", "districtId", "substationId"]) cases.push([access, `?${key}=${randomUUID()}`, 404]);
  cases.push([access, `?provinceId=${f.local.provinceId}&districtId=${f.foreign.publicId}`, 400]);
  cases.push([access, `?districtId=${f.local.publicId}&substationId=${f.stations[1].publicId}`, 400]);
  const { access: provincial } = await analyst({ readScope: "province", provinceId: f.local.provinceId });
  const { access: district } = await analyst({ readScope: "district", districtId: f.local.publicId });
  cases.push([provincial, `?provinceId=${f.foreign.provinceId}`, 403], [provincial, `?substationId=${f.stations[2].publicId}`, 403],
    [district, `?districtId=${f.sibling.publicId}`, 403], [district, `?substationId=${f.stations[1].publicId}`, 403],
    [provincial, `?provinceId=${f.local.provinceId}&districtId=${f.foreign.publicId}`, 403]);
  for (const [auth, query, status] of cases) {
    const result = await installations(auth, query, { "If-None-Match": "*" });
    assert.equal(result.status, status, query);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
    assert.equal(result.body.items, undefined);
    assert.equal(result.body.count, undefined);
  }
});

integration("installation list returns authorized empty collections and fails closed for broken implicit ancestry", async () => {
  const { access } = await analyst();
  const district = await models.District.findOne({});
  const empty = await models.GridSubstation.create({ name: "Empty", districtId: district.publicId });
  assert.deepEqual((await installations(access, `?substationId=${empty.publicId}`)).body,
    { count: 0, next: null, previous: null, items: [] });
  const { access: regionalAccess } = await analyst({ readScope: "district", districtId: district.publicId });
  await models.Province.collection.deleteMany({});
  for (const auth of [access, regionalAccess]) {
    const result = await installations(auth);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { count: 0, next: null, previous: null, items: [] });
  }
  assert.equal((await installations(access, `?districtId=${district.publicId}`)).status, 404);
});

integration("installation list ETags cover context, query and complete envelope with authorization before 304", async () => {
  const f = await installationListFixture();
  const { user, access } = await analyst();
  const query = "?limit=1";
  const first = await installations(access, query);
  const tag = first.headers.etag;
  for (const value of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const cached = await installations(access, query, { "If-None-Match": value });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.headers["content-type"], undefined);
    assert.equal(cached.headers.etag, tag);
    assert.equal(cached.headers["cache-control"], "private, no-cache");
  }
  assert.equal((await installations(access, query, { "If-Modified-Since": new Date("2099-01-01").toUTCString() })).status, 200);
  assert.notEqual((await installations(access, "?limit=2")).headers.etag, tag);
  const { access: other } = await analyst();
  assert.notEqual((await installations(other, query)).headers.etag, tag);
  await models.SolarInstallation.create({ substationId: f.stations[0].publicId, meterId: randomUUID(), deviceCredentialHash: "fixture-hash" });
  const changed = await installations(access, query, { "If-None-Match": tag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.count, 8);
  assert.notEqual(changed.headers.etag, tag);
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "district", districtId: f.local.publicId } });
  const rescoped = await installations(access, query, { "If-None-Match": changed.headers.etag });
  assert.equal(rescoped.status, 200);
  assert.equal(rescoped.body.count, 4);
  assert.equal((await installations(access, `?districtId=${f.foreign.publicId}`, { "If-None-Match": "*" })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await installations(access, "", { "If-None-Match": "*" })).status, 401);
});

integration("installation count/page use scoped filters and one snapshot, share read limits and sanitize failures", async t => {
  const f = await installationListFixture();
  const { user, access } = await analyst({ readScope: "district", districtId: f.local.publicId });
  const original = models.SolarInstallation.countDocuments;
  let inserted = false;
  const mock = t.mock.method(models.SolarInstallation, "countDocuments", function (filter) {
    assert.deepEqual(filter, { substationId: { $in: [f.stations[0].publicId] } });
    const query = original.call(this, filter);
    const execute = query.exec;
    query.exec = async function (...args) {
      const count = await execute.apply(this, args);
      if (!inserted) {
        inserted = true;
        await models.SolarInstallation.collection.insertOne({ publicId: randomUUID(), substationId: f.stations[0].publicId,
          meterId: randomUUID(), status: "active", deviceCredentialHash: "fixture-hash" });
      }
      return count;
    };
    return query;
  });
  const result = await installations(access);
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 3);
  assert.equal(result.body.items.length, 3);
  mock.mock.restore();
  assert.equal((await installations(access)).body.count, 4);
  const { createHash } = require("node:crypto");
  await Counter.updateOne({ _id: `user-read:${createHash("sha256").update(user.publicId).digest("hex")}` },
    { $set: { count: 119, expiresAt: new Date(Date.now() + 60000) } });
  assert.equal((await installationDetails(access)).status, 200);
  const limited = await installations(access, "", { "If-None-Match": result.headers.etag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  const { access: another } = await analyst();
  t.mock.method(models.SolarInstallation, "find", () => { throw new Error("private diagnostics"); });
  const failed = await installations(another);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.code, "INTERNAL_SERVER_ERROR");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI installation collection exposes documented filters, envelope and GET only", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths['/installations'];
  assert.deepEqual(Object.keys(resource), ["get"]);
  assert.deepEqual(resource.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(resource.get.parameters.filter(p => p.in === "query").map(p => p.name),
    ["provinceId", "districtId", "substationId", "offset", "limit"]);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[304].content, undefined);
  assert.equal(resource.get.responses[200].headers['Last-Modified'], undefined);
  assert.equal(resource.get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/InstallationList');
  assert.equal(spec.components.schemas.InstallationList.properties.items.items.$ref, '#/components/schemas/SolarInstallation');
});

function substationDetails(access, id, headers = {}) {
  return rawGet(`/grid-substations/${id}`, access, headers);
}

integration("substation details serve national/admin/province/district readers with exactly public fields", async () => {
  const station = await models.GridSubstation.findOne({});
  const district = await models.District.findOne({});
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access } = await analyst(fields);
    const result = await substationDetails(access, station.publicId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id: station.publicId, districtId: district.publicId, name: station.name });
    assert.deepEqual(Object.keys(result.body), ["id", "districtId", "name"]);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.match(result.headers.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("substation details reject foreign provinces/districts and sibling districts before validators", async () => {
  const station = await models.GridSubstation.findOne({});
  const local = await models.District.findOne({});
  const { access: national } = await analyst();
  const tag = (await substationDetails(national, station.publicId)).headers.etag;
  const province = await models.Province.create({ name: "Foreign" });
  const foreign = await models.District.create({ name: "Foreign", provinceId: province.publicId });
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  for (const fields of [{ readScope: "province", provinceId: province.publicId },
    { readScope: "district", districtId: foreign.publicId }, { readScope: "district", districtId: sibling.publicId }]) {
    const { access } = await analyst(fields);
    const result = await substationDetails(access, station.publicId, { "If-None-Match": tag });
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { code: "FORBIDDEN", message: "The substation is outside your permitted jurisdiction.", details: [] });
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("substation detail authenticates users, validates public IDs and fails closed on missing resources/ancestry", async () => {
  const station = await models.GridSubstation.findOne({});
  for (const access of [null, "invalid", token(), token({ actor: "user" }, { expiresIn: -1 })]) {
    const result = await substationDetails(access, station.publicId, { "If-None-Match": "*" });
    assert.equal(result.status, 401);
    assert.equal(result.headers["www-authenticate"], "Bearer");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["cache-control"], "no-store");
  }
  const { access } = await analyst();
  for (const id of ["invalid", "507f1f77bcf86cd799439011", station.publicId.replace(/^(.{14})4/, (_, prefix) => prefix + "1")]) {
    const result = await substationDetails(access, id, { "If-None-Match": "*" });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "INVALID_REQUEST");
    assert.equal(result.headers.etag, undefined);
  }
  const missing = await substationDetails(access, randomUUID(), { "If-None-Match": "*" });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { code: "NOT_FOUND", message: "Substation not found.", details: [] });
  for (const model of [models.District, models.Province]) {
    const saved = await model.collection.findOne({});
    await model.collection.deleteOne({ _id: saved._id });
    const result = await substationDetails(access, station.publicId, { "If-None-Match": "*" });
    assert.equal(result.status, 404);
    assert.equal(result.headers.etag, undefined);
    await model.collection.insertOne(saved);
  }
});

integration("substation conditional GET returns bodyless 304 and ETags track public metadata, not private fields", async () => {
  const station = await models.GridSubstation.findOne({});
  const { access } = await analyst();
  const first = await substationDetails(access, station.publicId);
  for (const value of [first.headers.etag, `W/${first.headers.etag}`, `"other", ${first.headers.etag}`, "*"]) {
    const result = await substationDetails(access, station.publicId, { "If-None-Match": value });
    assert.equal(result.status, 304);
    assert.equal(result.text, "");
    assert.equal(result.headers["content-type"], undefined);
    assert.equal(result.headers.etag, first.headers.etag);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
  const future = new Date("2099-01-01").toUTCString();
  assert.equal((await substationDetails(access, station.publicId, { "If-Modified-Since": future })).status, 200);
  assert.equal((await substationDetails(access, station.publicId, { "If-None-Match": '"other"', "If-Modified-Since": future })).status, 200);
  await models.GridSubstation.collection.updateOne({ publicId: station.publicId }, { $set: { __v: 99, privateField: "fixture-private" } });
  assert.equal((await substationDetails(access, station.publicId, { "If-None-Match": first.headers.etag })).status, 304);
  await models.GridSubstation.updateOne({ publicId: station.publicId }, { $set: { name: "Renamed" } });
  const changed = await substationDetails(access, station.publicId, { "If-None-Match": first.headers.etag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.name, "Renamed");
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.deepEqual(Object.keys(changed.body), ["id", "districtId", "name"]);
});

integration("substation GET rechecks stored jurisdiction and shared limits before 304 and sanitizes persistence failures", async t => {
  const station = await models.GridSubstation.findOne({});
  const { user, access } = await analyst();
  const tag = (await substationDetails(access, station.publicId)).headers.etag;
  const foreign = await models.Province.create({ name: "Changed assignment" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreign.publicId } });
  assert.equal((await substationDetails(access, station.publicId, { "If-None-Match": tag })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await substationDetails(access, station.publicId, { "If-None-Match": tag })).status, 401);
  const { user: admin, access: adminAccess } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(admin.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await installations(adminAccess)).status, 200);
  const limited = await substationDetails(adminAccess, station.publicId, { "If-None-Match": tag });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  assert.equal(limited.headers["cache-control"], "no-store");
  const { access: another } = await analyst();
  t.mock.method(models.GridSubstation, "findOne", () => { throw new Error("private diagnostics"); });
  const failed = await substationDetails(another, station.publicId);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI grid-substation detail documents public fields, user security and conditional GET only", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths['/grid-substations/{substationId}'];
  assert.deepEqual(Object.keys(resource), ["get"]);
  assert.deepEqual(resource.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(resource.get.parameters.filter(p => p.in === "path").map(p => p.name), ["substationId"]);
  assert.equal(resource.get.parameters.some(p => p.in === "query"), false);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[304].content, undefined);
  assert.equal(resource.get.responses[200].headers['Last-Modified'], undefined);
  assert.equal(resource.get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/GridSubstation');
  assert.deepEqual(spec.components.schemas.GridSubstation.required, ["id", "districtId", "name"]);
  assert.equal(spec.components.schemas.GridSubstation.additionalProperties, false);
});

function districtSubstations(access, id, headers = {}, query = "") {
  return rawGet(`/districts/${id}/grid-substations${query}`, access, headers);
}

integration("district substation list authorizes all scopes and returns the full parent-filtered public collection in deterministic order", async () => {
  const district = await models.District.findOne({});
  const sibling = await models.District.create({ name: "Sibling", provinceId: district.provinceId });
  await models.GridSubstation.create({ name: "Excluded", districtId: sibling.publicId });
  const added = await models.GridSubstation.create(Array.from({ length: 51 }, (_, index) => ({
    name: index % 2 ? "Alpha" : "Beta", districtId: district.publicId,
  })));
  const original = await models.GridSubstation.findOne({ name: "Test substation" });
  const expected = [...added, original].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.publicId < b.publicId ? -1 : 1);
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access } = await analyst(fields);
    const result = await districtSubstations(access, district.publicId);
    assert.equal(result.status, 200);
    assert.equal(result.body.count, 52);
    assert.equal(result.body.items.length, 52); // No hidden default page truncation.
    assert.deepEqual(result.body.items.map(s => s.id), expected.map(s => s.publicId));
    assert.deepEqual(Object.keys(result.body), ["count", "items"]);
    for (const item of result.body.items) {
      assert.equal(item.districtId, district.publicId);
      assert.deepEqual(Object.keys(item), ["id", "districtId", "name"]);
    }
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("district list rejects actors, invalid/missing parents and foreign/sibling jurisdictions before substation queries", async t => {
  const local = await models.District.findOne({});
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  const foreignProvince = await models.Province.create({ name: "Foreign" });
  const foreignDistrict = await models.District.create({ name: "Foreign", provinceId: foreignProvince.publicId });
  t.mock.method(models.GridSubstation, "find", () => { throw new Error("Substation query must not run"); });
  const { access } = await analyst();
  const cases = [[null, local.publicId, 401], ["invalid", local.publicId, 401], [token(), local.publicId, 401],
    [access, "invalid", 400], [access, local.publicId.replace(/^(.{14})4/, (_, prefix) => prefix + "1"), 400], [access, randomUUID(), 404]];
  const { access: provincial } = await analyst({ readScope: "province", provinceId: local.provinceId });
  const { access: district } = await analyst({ readScope: "district", districtId: local.publicId });
  cases.push([provincial, foreignDistrict.publicId, 403], [district, foreignDistrict.publicId, 403], [district, sibling.publicId, 403]);
  for (const [auth, id, status] of cases) {
    const result = await districtSubstations(auth, id, { "If-None-Match": "*" });
    assert.equal(result.status, status);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
    assert.equal(result.body.items, undefined);
    assert.equal(result.body.count, undefined);
    if (status === 401) assert.equal(result.headers["www-authenticate"], "Bearer");
  }
  await models.Province.collection.deleteOne({ publicId: local.provinceId });
  assert.equal((await districtSubstations(access, local.publicId)).status, 404);
});

integration("empty authorized district returns a complete empty collection; query options including pagination are rejected", async () => {
  const local = await models.District.findOne({});
  const empty = await models.District.create({ name: "Empty", provinceId: local.provinceId });
  const { access } = await analyst();
  const result = await districtSubstations(access, empty.publicId);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { count: 0, items: [] });
  for (const query of ["?offset=0", "?limit=1", "?sort=name", "?provinceId=" + local.provinceId, "?extra=x"]) {
    const invalid = await districtSubstations(access, local.publicId, { "If-None-Match": "*" }, query);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "INVALID_QUERY");
    assert.equal(invalid.headers.etag, undefined);
  }
});

integration("district collection conditional GET is bodyless and ETags cover full parent-scoped response and context", async () => {
  const district = await models.District.findOne({});
  const { user, access } = await analyst();
  const first = await districtSubstations(access, district.publicId);
  const tag = first.headers.etag;
  for (const value of [tag, `W/${tag}`, `"other", ${tag}`, "*"]) {
    const cached = await districtSubstations(access, district.publicId, { "If-None-Match": value });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.headers["content-type"], undefined);
    assert.equal(cached.headers.etag, tag);
    assert.equal(cached.headers["cache-control"], "private, no-cache");
  }
  assert.equal((await districtSubstations(access, district.publicId, { "If-Modified-Since": new Date("2099-01-01").toUTCString() })).status, 200);
  const { access: other } = await analyst();
  assert.notEqual((await districtSubstations(other, district.publicId)).headers.etag, tag);
  const sibling = await models.District.create({ name: "Sibling", provinceId: district.provinceId });
  await models.GridSubstation.create({ name: "Outside", districtId: sibling.publicId });
  assert.equal((await districtSubstations(access, district.publicId, { "If-None-Match": tag })).status, 304);
  await models.GridSubstation.create({ name: "Added", districtId: district.publicId });
  const changed = await districtSubstations(access, district.publicId, { "If-None-Match": tag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.count, 2);
  assert.notEqual(changed.headers.etag, tag);
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "district", districtId: sibling.publicId } });
  assert.equal((await districtSubstations(access, district.publicId, { "If-None-Match": changed.headers.etag })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await districtSubstations(access, district.publicId, { "If-None-Match": tag })).status, 401);
});

integration("district collection shares user-read limits before 304 and sanitizes persistence failures", async t => {
  const district = await models.District.findOne({});
  const { user, access } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(user.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  const first = await installations(access);
  assert.equal(first.status, 200);
  const limited = await districtSubstations(access, district.publicId, { "If-None-Match": "*" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  const { access: another } = await analyst();
  t.mock.method(models.GridSubstation, "find", () => { throw new Error("private diagnostics"); });
  const failed = await districtSubstations(another, district.publicId);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI district substation collection documents GET only, full envelope and no query options", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths['/districts/{districtId}/grid-substations'];
  assert.deepEqual(Object.keys(resource), ["get"]);
  assert.deepEqual(resource.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(resource.get.parameters.filter(p => p.in === "path").map(p => p.name), ["districtId"]);
  assert.equal(resource.get.parameters.some(p => p.in === "query"), false);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[304].content, undefined);
  assert.equal(resource.get.responses[200].headers['Last-Modified'], undefined);
  assert.equal(resource.get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/GridSubstationList');
  assert.equal(spec.components.schemas.GridSubstationList.properties.items.items.$ref, '#/components/schemas/GridSubstation');
  assert.deepEqual(spec.components.schemas.GridSubstationList.required, ["count", "items"]);
  assert.deepEqual(Object.keys(spec.components.schemas.GridSubstationList.properties), ["count", "items"]);
});

function districtDetails(access, id, headers = {}, query = "") {
  return rawGet(`/districts/${id}${query}`, access, headers);
}

integration("district detail serves all authorized scopes with only public fields and no related queries", async t => {
  const district = await models.District.findOne({});
  for (const model of [models.GridSubstation, models.SolarInstallation, models.GenerationReading]) {
    t.mock.method(model, "find", () => { throw new Error("Related collections must not be queried"); });
    t.mock.method(model, "findOne", () => { throw new Error("Related resources must not be queried"); });
  }
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: district.provinceId },
    { readScope: "district", districtId: district.publicId }]) {
    const { access } = await analyst(fields);
    const result = await districtDetails(access, district.publicId);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { id: district.publicId, provinceId: district.provinceId, name: district.name });
    assert.deepEqual(Object.keys(result.body), ["id", "provinceId", "name"]);
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.match(result.headers.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(result.headers["last-modified"], undefined);
  }
});

integration("district detail rejects foreign/sibling jurisdiction, device tokens, invalid/missing IDs and query options before validators", async () => {
  const local = await models.District.findOne({});
  const sibling = await models.District.create({ name: "Sibling", provinceId: local.provinceId });
  const province = await models.Province.create({ name: "Foreign" });
  const foreign = await models.District.create({ name: "Foreign", provinceId: province.publicId });
  const { access } = await analyst();
  const tag = (await districtDetails(access, local.publicId)).headers.etag;
  const { access: provincial } = await analyst({ readScope: "province", provinceId: local.provinceId });
  const { access: district } = await analyst({ readScope: "district", districtId: local.publicId });
  assert.equal((await districtDetails(provincial, sibling.publicId)).status, 200);
  for (const [auth, id, status] of [[null, local.publicId, 401], ["invalid", local.publicId, 401], [token(), local.publicId, 401],
    [access, "invalid", 400], [access, local.publicId.replace(/^(.{14})4/, (_, prefix) => prefix + "1"), 400],
    [access, randomUUID(), 404], [provincial, foreign.publicId, 403], [district, foreign.publicId, 403], [district, sibling.publicId, 403]]) {
    const result = await districtDetails(auth, id, { "If-None-Match": tag });
    assert.equal(result.status, status);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers["last-modified"], undefined);
    if (status === 401) assert.equal(result.headers["www-authenticate"], "Bearer");
  }
  assert.equal((await districtDetails(access, local.publicId, {}, "?limit=1")).status, 400);
  await models.Province.collection.deleteOne({ publicId: local.provinceId });
  const broken = await districtDetails(access, local.publicId, { "If-None-Match": "*" });
  assert.equal(broken.status, 404);
  assert.deepEqual(broken.body, { code: "NOT_FOUND", message: "District not found.", details: [] });
});

integration("district conditional GET returns bodyless 304 and tracks public metadata after renewed access checks", async () => {
  const district = await models.District.findOne({});
  const { user, access } = await analyst();
  const first = await districtDetails(access, district.publicId);
  for (const value of [first.headers.etag, `W/${first.headers.etag}`, `"other", ${first.headers.etag}`, "*"]) {
    const cached = await districtDetails(access, district.publicId, { "If-None-Match": value });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.headers["content-type"], undefined);
    assert.equal(cached.headers.etag, first.headers.etag);
    assert.equal(cached.headers["cache-control"], "private, no-cache");
  }
  const future = new Date("2099-01-01").toUTCString();
  assert.equal((await districtDetails(access, district.publicId, { "If-Modified-Since": future })).status, 200);
  assert.equal((await districtDetails(access, district.publicId, { "If-None-Match": '"other"', "If-Modified-Since": future })).status, 200);
  await models.District.collection.updateOne({ publicId: district.publicId }, { $set: { __v: 99, privateField: "fixture-private" } });
  assert.equal((await districtDetails(access, district.publicId, { "If-None-Match": first.headers.etag })).status, 304);
  await models.District.updateOne({ publicId: district.publicId }, { $set: { name: "Renamed" } });
  const changed = await districtDetails(access, district.publicId, { "If-None-Match": first.headers.etag });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.name, "Renamed");
  assert.notEqual(changed.headers.etag, first.headers.etag);
  assert.deepEqual(Object.keys(changed.body), ["id", "provinceId", "name"]);
  const foreign = await models.Province.create({ name: "Changed assignment" });
  await models.User.updateOne({ publicId: user.publicId }, { $set: { readScope: "province", provinceId: foreign.publicId } });
  assert.equal((await districtDetails(access, district.publicId, { "If-None-Match": changed.headers.etag })).status, 403);
  await models.User.deleteOne({ publicId: user.publicId });
  assert.equal((await districtDetails(access, district.publicId, { "If-None-Match": "*" })).status, 401);
});

integration("district detail shares read limits before 304 and returns sanitized persistence errors", async t => {
  const district = await models.District.findOne({});
  const { user, access } = await analyst({ role: "admin" });
  const { createHash } = require("node:crypto");
  await Counter.create({ _id: `user-read:${createHash("sha256").update(user.publicId).digest("hex")}`,
    count: 119, expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await districtSubstations(access, district.publicId)).status, 200);
  const limited = await districtDetails(access, district.publicId, { "If-None-Match": "*" });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.headers.etag, undefined);
  const { access: another } = await analyst();
  t.mock.method(models.District, "findOne", () => { throw new Error("private diagnostics"); });
  const failed = await districtDetails(another, district.publicId);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred.", details: [] });
  assert.equal(failed.headers["cache-control"], "no-store");
  assert.equal(failed.headers.etag, undefined);
});

test("OpenAPI district detail documents GET only, public fields and conditional responses without query options", () => {
  const spec = require("../docs/openapi.json");
  const resource = spec.paths['/districts/{districtId}'];
  assert.deepEqual(Object.keys(resource), ["get"]);
  assert.deepEqual(resource.get.security, [{ UserBearer: [] }]);
  assert.deepEqual(resource.get.parameters.filter(p => p.in === "path").map(p => p.name), ["districtId"]);
  assert.equal(resource.get.parameters.some(p => p.in === "query"), false);
  for (const status of [200, 304, 400, 401, 403, 404, 406, 429, 500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[304].content, undefined);
  assert.equal(resource.get.responses[200].headers['Last-Modified'], undefined);
  assert.equal(resource.get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/District');
  assert.deepEqual(spec.components.schemas.District.required, ["id", "provinceId", "name"]);
  assert.equal(spec.components.schemas.District.additionalProperties, false);
});

function provinceDistricts(access, id, headers = {}, query = "") {
  return rawGet(`/provinces/${id}/districts${query}`, access, headers);
}

integration("province district collection serves national/admin/province access and queries only the assigned district for district analysts", async t => {
  const local = await models.District.findOne({});
  const siblings = await models.District.create([{ name: "Alpha", provinceId: local.provinceId }, { name: "Alpha", provinceId: local.provinceId }]);
  const foreign = await models.Province.create({ name: "Foreign" });
  await models.District.create({ name: "Excluded", provinceId: foreign.publicId });
  const expected = [local, ...siblings].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.publicId < b.publicId ? -1 : 1);
  for (const fields of [{}, { role: "admin" }, { readScope: "province", provinceId: local.provinceId }]) {
    const { access } = await analyst(fields);
    const result = await provinceDistricts(access, local.provinceId);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.body), ["count", "items"]);
    assert.equal(result.body.count, 3);
    assert.deepEqual(result.body.items.map(r => r.id), expected.map(r => r.publicId));
    for (const item of result.body.items) {
      assert.equal(item.provinceId, local.provinceId);
      assert.deepEqual(Object.keys(item), ["id", "provinceId", "name"]);
    }
    assert.equal(result.headers["cache-control"], "private, no-cache");
    assert.equal(result.headers["last-modified"], undefined);
  }
  const original = models.District.find;
  t.mock.method(models.District, "find", function(filter) {
    assert.deepEqual(filter, { provinceId: local.provinceId, publicId: local.publicId });
    return original.call(this, filter);
  });
  const { access } = await analyst({ readScope: "district", districtId: local.publicId });
  const scoped = await provinceDistricts(access, local.provinceId);
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body, { count: 1, items: [{ id: local.publicId, provinceId: local.provinceId, name: local.name }] });
});

integration("province district collection denies other provinces and invalid actors/IDs before district list queries", async t => {
  const local = await models.District.findOne({});
  const foreign = await models.Province.create({ name: "Foreign" });
  const { access } = await analyst();
  const { access: provincial } = await analyst({ readScope: "province", provinceId: local.provinceId });
  const { access: district } = await analyst({ readScope: "district", districtId: local.publicId });
  t.mock.method(models.District, "find", () => { throw new Error("District result query must not run"); });
  for (const [auth,id,status] of [[null,local.provinceId,401], ["invalid",local.provinceId,401], [token(),local.provinceId,401],
    [access,"invalid",400], [access,randomUUID(),404], [provincial,foreign.publicId,403], [district,foreign.publicId,403]]) {
    const result = await provinceDistricts(auth,id,{ "If-None-Match":"*" });
    assert.equal(result.status,status);
    assert.equal(result.headers["cache-control"],"no-store");
    assert.equal(result.headers.etag,undefined);
    assert.equal(result.body.items,undefined);
    assert.equal(result.body.count,undefined);
    if(status===401) assert.equal(result.headers["www-authenticate"],"Bearer");
  }
  await models.District.collection.deleteOne({ publicId: local.publicId });
  assert.equal((await provinceDistricts(district,local.provinceId)).status,403);
});

integration("province district collection supports empty provinces and rejects pagination/sorting/geography query options", async () => {
  const empty=await models.Province.create({ name:"Empty" });
  const { access }=await analyst();
  const result=await provinceDistricts(access,empty.publicId);
  assert.equal(result.status,200);
  assert.deepEqual(result.body,{ count:0,items:[] });
  for(const query of ["?offset=0","?limit=1","?sort=name","?districtId="+randomUUID(),"?extra=x"]) {
    const invalid=await provinceDistricts(access,empty.publicId,{ "If-None-Match":"*" },query);
    assert.equal(invalid.status,400);
    assert.equal(invalid.body.code,"INVALID_QUERY");
    assert.equal(invalid.headers.etag,undefined);
  }
});

integration("province district ETags are bodyless on match, scoped against sibling changes, and recheck current access", async () => {
  const local=await models.District.findOne({});
  const { user,access }=await analyst({ readScope:"district",districtId:local.publicId });
  const first=await provinceDistricts(access,local.provinceId);
  for(const value of [first.headers.etag,`W/${first.headers.etag}`,`"other", ${first.headers.etag}`,"*"]) {
    const cached=await provinceDistricts(access,local.provinceId,{ "If-None-Match":value });
    assert.equal(cached.status,304); assert.equal(cached.text,"");
    assert.equal(cached.headers["content-type"],undefined);
    assert.equal(cached.headers.etag,first.headers.etag);
    assert.equal(cached.headers["cache-control"],"private, no-cache");
  }
  assert.equal((await provinceDistricts(access,local.provinceId,{ "If-Modified-Since":new Date("2099-01-01").toUTCString() })).status,200);
  await models.District.create({ name:"Sibling",provinceId:local.provinceId });
  assert.equal((await provinceDistricts(access,local.provinceId,{ "If-None-Match":first.headers.etag })).status,304);
  await models.District.updateOne({ publicId:local.publicId },{ $set:{ name:"Renamed" } });
  const changed=await provinceDistricts(access,local.provinceId,{ "If-None-Match":first.headers.etag });
  assert.equal(changed.status,200); assert.notEqual(changed.headers.etag,first.headers.etag);
  const foreign=await models.Province.create({ name:"New assignment" });
  await models.User.updateOne({ publicId:user.publicId },{ $set:{ readScope:"province",provinceId:foreign.publicId },$unset:{ districtId:"" } });
  assert.equal((await provinceDistricts(access,local.provinceId,{ "If-None-Match":changed.headers.etag })).status,403);
  await models.User.deleteOne({ publicId:user.publicId });
  assert.equal((await provinceDistricts(access,local.provinceId,{ "If-None-Match":"*" })).status,401);
});

integration("province district collections share read limits and sanitize persistence failures", async t => {
  const local=await models.District.findOne({});
  const { user,access }=await analyst({ role:"admin" });
  const { createHash }=require("node:crypto");
  await Counter.create({ _id:`user-read:${createHash("sha256").update(user.publicId).digest("hex")}`,count:119,expiresAt:new Date(Date.now()+60000) });
  assert.equal((await districtDetails(access,local.publicId)).status,200);
  const limited=await provinceDistricts(access,local.provinceId,{ "If-None-Match":"*" });
  assert.equal(limited.status,429); assert.ok(Number(limited.headers["retry-after"])>0);
  assert.equal(limited.headers.etag,undefined);
  const { access:another }=await analyst();
  t.mock.method(models.District,"find",()=>{ throw Error("private diagnostics"); });
  const failed=await provinceDistricts(another,local.provinceId);
  assert.equal(failed.status,500); assert.equal(failed.body.code,"INTERNAL_SERVER_ERROR");
  assert.equal(failed.headers.etag,undefined); assert.equal(failed.headers["cache-control"],"no-store");
});

test("OpenAPI province district collection documents scoped public items without query options or paging fields", () => {
  const spec=require("../docs/openapi.json");
  const resource=spec.paths['/provinces/{provinceId}/districts'];
  assert.deepEqual(Object.keys(resource),["get"]);
  assert.deepEqual(resource.get.security,[{ UserBearer:[] }]);
  assert.deepEqual(resource.get.parameters.filter(p=>p.in==="path").map(p=>p.name),["provinceId"]);
  assert.equal(resource.get.parameters.some(p=>p.in==="query"),false);
  for(const status of [200,304,400,401,403,404,406,429,500]) assert.ok(resource.get.responses[status]);
  assert.equal(resource.get.responses[304].content,undefined);
  assert.deepEqual(spec.components.schemas.DistrictList.required,["count","items"]);
  assert.equal(spec.components.schemas.DistrictList.properties.items.items.$ref,'#/components/schemas/District');
});
