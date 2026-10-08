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

test("OpenAPI documents implemented creation, public response and admin policy without PATCH/DELETE", () => {
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
  assert.equal(spec.paths["/installations/{installationId}"].patch, undefined);
  assert.equal(spec.paths["/installations/{installationId}"].delete, undefined);
});

