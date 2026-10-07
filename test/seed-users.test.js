const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const mongoose = require("mongoose");
const models = require("../src/models");
const { createSites } = require("../scripts/seed-data");
const { accountDefinitions, loadAccounts, seedUsers } = require("../scripts/seed-users");
const scryptAsync = promisify(scrypt);

function environment() {
  return Object.fromEntries(accountDefinitions().flatMap((account, index) => [
    [`${account.prefix}_EMAIL`, `analyst${index}@example.com`],
    [`${account.prefix}_PASSWORD`, "test-only password"],
  ]));
}

function database(t) {
  const provinces = [...new Set(createSites().map(site => site.provinceName))]
    .map(name => ({ name, publicId: randomUUID() }));
  const districts = createSites().map(site => ({
    name: site.districtName, publicId: randomUUID(),
    provinceId: provinces.find(province => province.name === site.provinceName).publicId,
  }));
  const users = [];
  let writes = 0;
  t.mock.method(models.User, "createIndexes", async () => {});
  t.mock.method(mongoose.connection, "transaction", async callback => {
    const backup = users.map(user => ({ ...user }));
    try { return await callback(null); }
    catch (error) { users.splice(0, users.length, ...backup); throw error; }
  });
  for (const [Model, records] of [[models.Province, provinces], [models.District, districts], [models.User, users]]) {
    t.mock.method(Model, "find", filter => ({
      select() { return this; }, session() { return this; },
      async lean() {
        const field = filter.email ? "email" : "name";
        return records.filter(record => filter[field].$in.includes(record[field])).map(record => ({ ...record }));
      },
    }));
    if (Model !== models.User) t.mock.method(Model, "exists", filter => ({
      session: async () => records.find(record => record.publicId === filter.publicId) || null,
    }));
  }
  t.mock.method(models.User.collection, "bulkWrite", async operations => {
    writes++;
    let upsertedCount = 0;
    for (const { updateOne } of operations) {
      assert.deepEqual(Object.keys(updateOne.update), ["$setOnInsert"]);
      assert.equal(updateOne.upsert, true);
      if (!users.some(user => user.email === updateOne.filter.email)) {
        users.push({ ...updateOne.update.$setOnInsert });
        upsertedCount++;
      }
    }
    return { upsertedCount };
  });
  return { users, provinces, districts, writes: () => writes };
}

test("user seed requires 36 distinct valid email/password pairs without exposing values", () => {
  const env = environment();
  assert.equal(loadAccounts(env).length, 36);
  delete env.SEED_PROVINCE_WESTERN_PASSWORD;
  assert.throws(() => loadAccounts(env), /Missing credentials: SEED_PROVINCE_WESTERN_PASSWORD/);
  env.SEED_PROVINCE_WESTERN_PASSWORD = "   ";
  assert.throws(() => loadAccounts(env), /Missing credentials/);
  env.SEED_PROVINCE_WESTERN_PASSWORD = "test-only password";
  env.SEED_NATIONAL_EMAIL = ` ${env.SEED_ADMIN_EMAIL.toUpperCase()} `;
  assert.throws(() => loadAccounts(env), /Duplicate account email in SEED_ADMIN_EMAIL and SEED_NATIONAL_EMAIL/);
  env.SEED_NATIONAL_EMAIL = "invalid-address";
  assert.throws(() => loadAccounts(env), /Invalid email configuration: SEED_NATIONAL_EMAIL/);
});

test("user seed stores correctly salted hashes and existing public geography IDs for all scopes", async t => {
  const db = database(t);
  const env = environment();
  env.SEED_ADMIN_EMAIL = ` ${env.SEED_ADMIN_EMAIL.toUpperCase()} `;
  const result = await seedUsers({ env });
  assert.equal(result.inserted, 36);
  assert.equal(result.verified, 36);
  assert.equal(result.preserved, 0);
  assert.deepEqual(result.counts, { admin: 1, nationalAnalysts: 1, provincialAnalysts: 9, districtAnalysts: 25 });
  const accounts = loadAccounts(env);
  const salts = new Set();
  for (const account of accounts) {
    const user = db.users.find(user => user.email === account.email);
    assert.equal(user.role, account.role);
    assert.equal(user.readScope, account.readScope);
    assert.match(user.publicId, /^[0-9a-f-]{36}$/);
    assert.equal(Object.hasOwn(user, "password"), false);
    assert.equal(Object.hasOwn(user, "active"), false);
    assert.equal(Object.hasOwn(new models.User(user).toJSON(), "passwordHash"), false);
    if (account.readScope === "national") {
      assert.equal(user.provinceId, undefined);
      assert.equal(user.districtId, undefined);
    } else if (account.readScope === "province") {
      assert.equal(user.provinceId, db.provinces.find(province => province.name === account.provinceName).publicId);
      assert.equal(user.districtId, undefined);
    } else {
      assert.equal(user.districtId, db.districts.find(district => district.name === account.districtName).publicId);
      assert.equal(user.provinceId, undefined);
    }
    const [algorithm, salt, hash] = user.passwordHash.split("$");
    assert.equal(algorithm, "scrypt");
    assert.match(salt, /^[0-9a-f]{32}$/);
    assert.equal((await scryptAsync(account.password, salt, 64)).toString("hex"), hash);
    salts.add(salt);
  }
  assert.equal(salts.size, 36);
});

test("user seed reruns preserve complete records, changed passwords/access, and unrelated users", async t => {
  const db = database(t);
  const env = environment();
  await seedUsers({ env });
  const analyst = db.users.find(user => user.readScope === "district");
  analyst.districtId = db.districts.find(district => district.publicId !== analyst.districtId).publicId;
  analyst.passwordHash = "previously-rotated-password-hash";
  db.users.push({ email: "unrelated@example.com", publicId: randomUUID(), passwordHash: "unrelated-hash" });
  const snapshot = JSON.stringify(db.users);
  for (const key of Object.keys(env)) if (key.endsWith("_PASSWORD")) env[key] = "changed seed password";
  const result = await seedUsers({ env });
  assert.equal(result.inserted, 0);
  assert.equal(result.preserved, 36);
  assert.equal(result.preservedAssignmentsDiffer, 1);
  assert.equal(db.writes(), 1);
  assert.equal(JSON.stringify(db.users), snapshot);
});

test("missing credentials or missing/ambiguous geography prevent all user writes", async t => {
  const db = database(t);
  const env = environment();
  delete env.SEED_ADMIN_PASSWORD;
  await assert.rejects(seedUsers({ env }), /Missing credentials/);
  env.SEED_ADMIN_PASSWORD = "test password";
  const district = db.districts.pop();
  await assert.rejects(seedUsers({ env }), /Missing or ambiguous district/);
  db.districts.push(district);
  db.districts[0].provinceId = randomUUID();
  await assert.rejects(seedUsers({ env }), /Missing or ambiguous district: Colombo/);
  db.provinces.push({ ...db.provinces[0], publicId: randomUUID() });
  await assert.rejects(seedUsers({ env }), /Missing or ambiguous province: Western/);
  assert.equal(db.users.length, 0);
  assert.equal(db.writes(), 0);
});

test("invalid geography UUIDs and failed verification roll back account insertion", async t => {
  const db = database(t);
  const env = environment();
  const id = db.provinces[0].publicId;
  db.provinces[0].publicId = "not-a-public-uuid";
  await assert.rejects(seedUsers({ env }), /Missing or ambiguous district|User schema validation failed/);
  db.provinces[0].publicId = id;
  const bulkWrite = models.User.collection.bulkWrite;
  t.mock.method(models.User.collection, "bulkWrite", async (...args) => {
    const result = await bulkWrite(...args);
    db.users[0].role = "user";
    return result;
  });
  await assert.rejects(seedUsers({ env }), /User verification failed/);
  assert.equal(db.users.length, 0);
});
