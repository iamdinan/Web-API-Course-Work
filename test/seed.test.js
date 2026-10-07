const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const { spawnSync } = require("node:child_process");
const models = require("../src/models");
const { createSites, generateReadings, EXPECTED, START, INTERVAL_MS, SAMPLES } = require("../scripts/seed-data");
const { insertReadingBatch, seedHierarchy } = require("../scripts/seed");
const { verifyPassword } = require("../src/services/passwords");

test("full seed covers all geography and 147840 coherent quarter-hour readings", () => {
  const sites = createSites();
  for (const site of sites) {
    assert.equal(site.substationName, `${site.districtName} Grid Substation`);
    for (const profile of site.installations) assert.match(profile.meterId, /^METER-\d{2}-\d{2}$/);
  }
  assert.equal(new Set(sites.map(site => site.provinceName)).size, EXPECTED.provinces);
  assert.equal(new Set(sites.map(site => site.districtName)).size, EXPECTED.districts);
  assert.equal(new Set(sites.map(site => site.substationName)).size, EXPECTED.grid_substations);
  const profiles = sites.flatMap(site => site.installations);
  assert.equal(profiles.length, EXPECTED.solar_installations);
  assert.equal(new Set(profiles.map(profile => profile.meterId)).size, profiles.length);
  let total = 0;
  for (const profile of profiles) {
    const id = randomUUID();
    const readings = [...generateReadings(id, profile.profileIndex)];
    assert.equal(readings.length, SAMPLES);
    assert.deepEqual(readings, [...generateReadings(id, profile.profileIndex)]);
    assert.equal(+readings[0].recordedAt, +START);
    assert.equal(+readings.at(-1).recordedAt, +START + (SAMPLES - 1) * INTERVAL_MS);
    for (let index = 0; index < readings.length; index++) {
      const reading = readings[index];
      assert.equal(reading.installationId, id);
      const hour = (index % 96) / 4;
      if (hour <= 6 || hour >= 18) assert.equal(reading.powerKw, 0);
      else assert.ok(reading.powerKw > 0 && reading.powerKw <= 15);
      assert.equal(+reading.receivedAt - +reading.recordedAt, 5000);
      if (index) {
        const previous = readings[index - 1];
        assert.equal(+reading.recordedAt - +previous.recordedAt, INTERVAL_MS);
        assert.ok(reading.energyKwh >= previous.energyKwh);
        assert.ok(Math.abs(reading.energyKwh - previous.energyKwh - (previous.powerKw + reading.powerKw) * 0.125) < 0.000002);
      }
    }
    total += readings.length;
  }
  assert.equal(total, EXPECTED.generation_readings);
});

test("reading batches insert only missing samples and preserve existing IDs and values", async t => {
  const stored = [];
  let locks = 0;
  let bulkCalls = 0;
  let parentExists = true;
  t.mock.method(mongoose.connection, "transaction", callback => callback(null));
  t.mock.method(models.GenerationReading.collection, "find", query => ({ toArray: async () => stored.filter(record => record.installationId === query.installationId && record.recordedAt >= query.recordedAt.$gte && record.recordedAt <= query.recordedAt.$lte) }));
  t.mock.method(models.SolarInstallation.collection, "updateOne", async (filter, update) => {
    if (parentExists) locks += update.$set ? 1 : -1;
    return { matchedCount: parentExists ? 1 : 0 };
  });
  t.mock.method(models.GenerationReading.collection, "bulkWrite", async operations => {
    bulkCalls++;
    for (const { updateOne } of operations) {
      assert.deepEqual(Object.keys(updateOne.update), ["$setOnInsert"]);
      assert.equal(updateOne.upsert, true);
      assert.match(updateOne.update.$setOnInsert.publicId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      stored.push(updateOne.update.$setOnInsert);
    }
    return { upsertedCount: operations.length };
  });
  const batch = [...generateReadings(randomUUID(), 0)];
  assert.equal(await insertReadingBatch(batch), 672);
  stored[20].powerKw = 123; // Reruns cannot overwrite retained history.
  const snapshot = JSON.stringify(stored);
  assert.equal(await insertReadingBatch(batch), 0);
  assert.equal(JSON.stringify(stored), snapshot);
  assert.equal(bulkCalls, 1);
  assert.equal(locks, 0);
  const removed = stored.pop();
  const preserved = JSON.stringify(stored);
  assert.equal(await insertReadingBatch(batch), 1);
  assert.equal(JSON.stringify(stored.slice(0, -1)), preserved);
  assert.equal(+stored.at(-1).recordedAt, +removed.recordedAt);
  assert.equal(locks, 0);
  assert.equal(await insertReadingBatch([]), 0);
  await assert.rejects(insertReadingBatch([...batch, { ...batch[0], installationId: randomUUID() }]), /one installation/);
  await assert.rejects(insertReadingBatch(Array(1001).fill(batch[0])), /at most/);
  parentExists = false;
  const beforeMissingParent = JSON.stringify(stored);
  await assert.rejects(insertReadingBatch([...generateReadings(randomUUID(), 0)]), /parent disappeared/);
  assert.equal(JSON.stringify(stored), beforeMissingParent);
});

test("new seeded installations use prefix passwords by default and reruns never rotate hashes", async t => {
  const province = { publicId: randomUUID(), name: "Western" };
  const district = { publicId: randomUUID(), name: "Colombo", provinceId: province.publicId };
  const substation = { publicId: randomUUID(), name: "Colombo Grid Substation", districtId: district.publicId };
  const site = createSites()[0];
  site.installations = site.installations.slice(0, 1);
  let stored;
  t.mock.method(mongoose.connection, "transaction", callback => callback(null));
  for (const [name, record] of [["Province", province], ["District", district], ["GridSubstation", substation]]) {
    t.mock.method(models[name], "find", filter => ({ session: () => ({ limit: async () => {
      for (const [key, value] of Object.entries(filter)) assert.equal(record[key], value);
      return [record];
    } }) }));
  }
  t.mock.method(models.SolarInstallation, "findOne", () => ({ session: async () => stored || null }));
  t.mock.method(models.SolarInstallation.prototype, "save", async function () {
    stored = this.toObject();
    return this;
  });
  const env = { DEVICE_HASH_COMMON_PREFIX: " test-development- " };
  const result = await seedHierarchy([site], () => {}, env);
  assert.deepEqual(result, [{ publicId: stored.publicId, profileIndex: site.installations[0].profileIndex }]);
  assert.equal(stored.substationId, substation.publicId);
  assert.equal(await verifyPassword(" test-development- " + site.installations[0].meterId, stored.deviceCredentialHash), true);
  assert.equal(await verifyPassword(" test-development- OTHER-METER", stored.deviceCredentialHash), false);
  stored.status = "inactive";
  stored.deviceCredentialHash = "independently-rotated-hash";
  const snapshot = JSON.stringify({ province, district, substation, stored });
  assert.deepEqual(await seedHierarchy([site], () => {}, { DEVICE_HASH_COMMON_PREFIX: "changed-prefix-" }), result);
  assert.equal(JSON.stringify({ province, district, substation, stored }), snapshot);
  stored.substationId = randomUUID();
  await assert.rejects(seedHierarchy([site], () => {}, env), /conflicting parent/);
  for (const prefix of [undefined, "", " "]) {
    await assert.rejects(seedHierarchy([site], () => {}, { DEVICE_HASH_COMMON_PREFIX: prefix }), /DEVICE_HASH_COMMON_PREFIX/);
  }
});

test("seed CLI reports missing device prefix before connecting or writing", () => {
  const result = spawnSync(process.execPath, ["scripts/seed.js"], {
    env: { ...process.env, DEVICE_HASH_COMMON_PREFIX: "" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set DEVICE_HASH_COMMON_PREFIX in .env/);
  assert.equal(result.stdout.includes("Connecting to MongoDB"), false);
});
