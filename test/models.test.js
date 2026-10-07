const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const models = require("../src/models");
const { randomUUID } = require("node:crypto");
const { generateReadings } = require("../scripts/seed-data");
const provinceId = randomUUID();
const districtId = randomUUID();
const installationId = randomUUID();
const data = {
  province: { publicId: provinceId, name: "Western" },
  district: { publicId: districtId, provinceId, name: "Colombo" },
  installations: [{ publicId: installationId, substationId: randomUUID(), meterId: "METER-01-01", status: "active" }],
  readings: [generateReadings(installationId, 0).next().value],
};

test("all models have unique public UUID indexes and safe public JSON", () => {
  for (const Model of Object.values(models)) {
    assert.ok(Model.schema.indexes().some(([keys, options]) => keys.publicId === 1 && options.unique));
    const document = new Model();
    assert.match(document.publicId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(document.publicId, new Model().publicId);
    const json = document.toJSON();
    assert.equal(json.id, document.publicId);
    for (const field of ["_id", "__v", "publicId", "passwordHash", "deviceCredentialHash"]) {
      assert.equal(Object.hasOwn(json, field), false);
    }
    assert.equal(Model.schema.options.id, false);
  }
  const installation = new models.SolarInstallation({ ...data.installations[0], deviceCredentialHash: "private-hash" });
  assert.equal(Object.hasOwn(installation.toJSON(), "deviceCredentialHash"), false);
  assert.equal(models.SolarInstallation.schema.path("deviceCredentialHash").options.select, false);
  assert.equal(models.User.schema.path("passwordHash").options.select, false);
});

test("meter, email, reading uniqueness and history indexes match the contract", () => {
  assert.ok(models.SolarInstallation.schema.indexes().some(([keys, options]) => keys.meterId === 1 && options.unique));
  assert.ok(models.User.schema.indexes().some(([keys, options]) => keys.email === 1 && options.unique));
  const indexes = models.GenerationReading.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.installationId === 1 && keys.recordedAt === 1 && options.unique));
  assert.ok(indexes.some(([keys]) => keys.installationId === 1 && keys.recordedAt === -1 && keys.publicId === -1));
});

test("UUIDs, measurements, statuses and unknown fields are validated", async t => {
  for (const name of ["GridSubstation", "SolarInstallation"]) {
    t.mock.method(models[name], "exists", () => ({ session: async () => ({ _id: "internal" }) }));
  }
  await assert.rejects(new models.Province({ publicId: "not-a-uuid", name: "Test" }).validate(), error => Boolean(error.errors.publicId));
  await assert.rejects(new models.SolarInstallation({ ...data.installations[0], status: "deleted", deviceCredentialHash: "hash" }).validate(), error => Boolean(error.errors.status));
  for (const value of [-1, Infinity, NaN]) {
    await assert.rejects(new models.GenerationReading({ ...data.readings[0], powerKw: value }).validate(), error => Boolean(error.errors.powerKw));
  }
  assert.throws(() => new models.User({ active: true }), /not in schema/);
});

test("user scope matches jurisdiction and admins have only national assignments", async t => {
  for (const name of ["Province", "District"]) {
    t.mock.method(models[name], "exists", () => ({ session: async () => ({ _id: "internal" }) }));
  }
  const base = { email: "Analyst@example.com", passwordHash: "private-hash", role: "user" };
  for (const fields of [
    { readScope: "national" },
    { readScope: "province", provinceId: data.province.publicId },
    { readScope: "district", districtId: data.district.publicId },
    { role: "admin", readScope: "national" },
  ]) {
    const user = new models.User({ ...base, ...fields });
    await user.validate();
    assert.equal(user.email, "analyst@example.com");
    assert.equal(Object.hasOwn(user.toJSON(), "passwordHash"), false);
  }
  for (const fields of [
    { readScope: "national", provinceId: data.province.publicId },
    { readScope: "province" },
    { readScope: "district", districtId: data.district.publicId, provinceId: data.province.publicId },
    { role: "admin", readScope: "district", districtId: data.district.publicId },
  ]) await assert.rejects(new models.User({ ...base, ...fields }).validate(), /ValidationError/);
});

test("child documents reject missing parents", async t => {
  t.mock.method(models.Province, "exists", () => ({ session: async () => null }));
  await assert.rejects(new models.District(data.district).validate(), /Province must exist/);
});

test("reading updates, replacement and deletion are blocked before database access", async () => {
  const filter = { publicId: data.readings[0].publicId };
  await assert.rejects(models.GenerationReading.updateOne(filter, { $set: { powerKw: 5 } }), /append-only/);
  await assert.rejects(models.GenerationReading.findOneAndUpdate(filter, { $set: { powerKw: 5 } }), /append-only/);
  await assert.rejects(models.GenerationReading.replaceOne(filter, data.readings[0]), /append-only/);
  await assert.rejects(models.GenerationReading.deleteOne(filter), /append-only/);
  await assert.rejects(models.GenerationReading.deleteMany({}), /append-only/);
  await assert.rejects(models.GenerationReading.bulkWrite([{ deleteOne: { filter } }]), /append-only/);
});

test("public reading dates use Sri Lankan time without changing stored instants", () => {
  const reading = new models.GenerationReading(data.readings[0]);
  const json = reading.toJSON();
  assert.equal(json.recordedAt, "2026-09-30T00:00:00.000+05:30");
  assert.equal(json.receivedAt, "2026-09-30T00:00:05.000+05:30");
  assert.equal(new Date(json.recordedAt).getTime(), reading.recordedAt.getTime());
  assert.equal(reading.recordedAt.toISOString(), "2026-09-29T18:30:00.000Z");
});
