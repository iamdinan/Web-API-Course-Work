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
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
process.env.JWT_SIGNING_KEY = "isolated-reading-tests-key-at-least-32-bytes";
process.env.JWT_ISSUER = "reading-tests";
process.env.JWT_AUDIENCE = "reading-api";
const config = require("../src/config/jwt");
const app = require("../src/app");
const models = require("../src/models");
const { Counter } = require("../src/services/token-rate-limit.service");
const { createReading } = require("../src/services/readings.service");
const { parseRecordedAt } = require("../src/middleware/reading-request");
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
  assert.ok(json.receivedAt.endsWith("+05:30"));
  assert.deepEqual(Object.keys(json).sort(), ["id", "installationId", "recordedAt", "receivedAt", "powerKw", "energyKwh", "voltageV"].sort());
  assert.equal(response.headers.get("location"), `/api/v1.0/installations/${installationId}/readings/${json.id}`);
  assert.equal(response.headers.get("last-modified"), new Date(json.receivedAt).toUTCString());
  const serialized = JSON.stringify(json);
  assert.equal(response.headers.get("etag"), require("etag")(serialized));
  assert.equal(await count(), 1);
  const stored = await models.GenerationReading.findOne({ publicId: json.id });
  assert.equal(stored.receivedAt.getTime(), new Date(json.receivedAt).getTime());
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
integration("OpenAPI exposes only the reading POST with public schemas and required headers", async () => {
  const spec = await (await fetch(`${origin}/openapi.json`)).json();
  const path = spec.paths["/installations/{installationId}/readings"];
  assert.deepEqual(Object.keys(path), ["post"]);
  assert.deepEqual(path.post.security, [{ InstallationBearer: [] }]);
  for (const status of [201, 400, 401, 403, 406, 409, 413, 415, 429, 500]) assert.ok(path.post.responses[status]);
  for (const header of ["Location", "ETag", "Last-Modified"]) assert.ok(path.post.responses[201].headers[header]);
  assert.ok(path.post.responses[429].headers["Retry-After"]);
  assert.equal(spec.components.schemas.ReadingInput.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.ReadingInput.required, Object.keys(body));
  assert.deepEqual(Object.keys(spec.components.schemas.GenerationReading.properties).sort(), ["id", "installationId", "recordedAt", "receivedAt", "powerKw", "energyKwh", "voltageV"].sort());
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
