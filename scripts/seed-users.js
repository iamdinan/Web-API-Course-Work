const mongoose = require("mongoose");
const { isDeepStrictEqual, parseEnv } = require("node:util");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const models = require("../src/models");
const { createSites } = require("./seed-data");
const { hashPassword } = require("../src/services/passwords");

class SeedUsersError extends Error {}

function accountDefinitions() {
  const sites = createSites();
  const provinces = [...new Set(sites.map(site => site.provinceName))];
  const key = name => name.toUpperCase().replace(/\s+/g, "_");
  return [
    { prefix: "SEED_ADMIN", role: "admin", readScope: "national" },
    { prefix: "SEED_NATIONAL", role: "user", readScope: "national" },
    ...provinces.map(provinceName => ({
      prefix: `SEED_PROVINCE_${key(provinceName)}`, role: "user", readScope: "province", provinceName,
    })),
    ...sites.map(({ provinceName, districtName }) => ({
      // The supplied credential file spells Moneragala as MONARAGALA.
      prefix: `SEED_DISTRICT_${key(districtName === "Moneragala" ? "Monaragala" : districtName)}`,
      role: "user", readScope: "district", provinceName, districtName,
    })),
  ];
}

function loadUserEnvironment() {
  try {
    // This dedicated file is authoritative; .env may have unrelated seed values.
    return parseEnv(readFileSync(path.resolve(__dirname, "../seed-users.env"), "utf8"));
  } catch {
    throw new SeedUsersError("Cannot read seed-users.env; provide the 36 account credential pairs in that ignored file.");
  }
}

function loadAccounts(env = process.env) {
  const missing = [];
  const invalid = [];
  const seen = new Map();
  const accounts = accountDefinitions().map(definition => {
    const emailKey = `${definition.prefix}_EMAIL`;
    const passwordKey = `${definition.prefix}_PASSWORD`;
    const email = typeof env[emailKey] === "string" ? env[emailKey].trim().toLowerCase() : "";
    const password = typeof env[passwordKey] === "string" ? env[passwordKey] : "";
    if (!email) missing.push(emailKey);
    else if (!models.User.schema.path("email").options.match.test(email)) invalid.push(emailKey);
    if (!password.trim()) missing.push(passwordKey);
    if (email && seen.has(email)) {
      throw new SeedUsersError(`Duplicate account email in ${seen.get(email)} and ${emailKey}.`);
    }
    if (email) seen.set(email, emailKey);
    return { ...definition, email, password };
  });
  if (missing.length) throw new SeedUsersError(`Missing credentials: ${missing.join(", ")}.`);
  if (invalid.length) throw new SeedUsersError(`Invalid email configuration: ${invalid.join(", ")}.`);
  return accounts;
}

async function resolveAccounts(accounts, session) {
  const provinces = await models.Province.find({
    name: { $in: [...new Set(accounts.map(account => account.provinceName).filter(Boolean))] },
  }).select("publicId name").session(session).lean();
  const districts = await models.District.find({
    name: { $in: accounts.map(account => account.districtName).filter(Boolean) },
  }).select("publicId name provinceId").session(session).lean();
  return accounts.map(account => {
    const fields = { email: account.email, role: account.role, readScope: account.readScope };
    if (account.readScope === "national") return { account, fields };
    const matches = provinces.filter(province => province.name === account.provinceName);
    if (matches.length !== 1) {
      throw new SeedUsersError(`Missing or ambiguous province: ${account.provinceName}. Run npm run seed first.`);
    }
    const province = matches[0];
    if (account.readScope === "province") fields.provinceId = province.publicId;
    else {
      const matches = districts.filter(district => district.name === account.districtName && district.provinceId === province.publicId);
      if (matches.length !== 1) {
        throw new SeedUsersError(`Missing or ambiguous district: ${account.districtName} in ${account.provinceName}. Run npm run seed first.`);
      }
      fields.districtId = matches[0].publicId;
    }
    return { account, fields };
  });
}

async function readUsers(emails, session) {
  return models.User.find({ email: { $in: emails } }).select("+passwordHash").session(session).lean();
}

async function seedUsers({ env = process.env } = {}) {
  // Validate every credential before connecting/writing, including on reruns.
  const accounts = loadAccounts(env);
  await models.User.createIndexes();
  return mongoose.connection.transaction(async session => {
    // Resolve all geography before making any account writes.
    const resolved = await resolveAccounts(accounts, session);
    const emails = accounts.map(account => account.email);
    const before = new Map((await readUsers(emails, session)).map(user => [user.email, user]));
    const operations = [];
    const insertedDocuments = new Map();
    for (const { account, fields } of resolved) {
      if (before.has(account.email)) continue;
      const document = new models.User({ ...fields, passwordHash: await hashPassword(account.password) });
      document.$session(session);
      try {
        // Full document validation enforces cross-field scope and parent checks.
        await document.validate();
      } catch {
        throw new SeedUsersError(`User schema validation failed for ${account.prefix}; check credentials and geography references.`);
      }
      const insert = document.toObject();
      insertedDocuments.set(account.email, insert);
      operations.push({ updateOne: {
        filter: { email: account.email }, update: { $setOnInsert: insert }, upsert: true,
      } });
    }
    // Setup-only raw writes use fully validated documents and insert-only values.
    const result = operations.length
      ? await models.User.collection.bulkWrite(operations, { ordered: true, session })
      : { upsertedCount: 0 };
    const after = await readUsers(emails, session);
    if (after.length !== accounts.length) throw new SeedUsersError("User verification failed: expected all 36 configured accounts.");
    const counts = { admin: 0, nationalAnalysts: 0, provincialAnalysts: 0, districtAnalysts: 0 };
    let preservedAssignmentsDiffer = 0;
    for (const { account, fields } of resolved) {
      const user = after.find(user => user.email === account.email);
      const expected = before.get(account.email) || insertedDocuments.get(account.email);
      const unchanged = before.has(account.email)
        ? isDeepStrictEqual(user, expected)
        : Object.entries(expected).every(([key, value]) => isDeepStrictEqual(user?.[key], value));
      if (!user || !unchanged) throw new SeedUsersError(`User verification failed for ${account.prefix}: stored values differ.`);
      try {
        const document = new models.User(user);
        document.$session(session);
        await document.validate();
      } catch {
        throw new SeedUsersError(`User verification failed for ${account.prefix}: invalid stored schema or geography reference.`);
      }
      if (before.has(account.email) && ["role", "readScope", "provinceId", "districtId"].some(key => user[key] !== fields[key])) {
        preservedAssignmentsDiffer++;
      }
      if (user.role === "admin") counts.admin++;
      else if (user.readScope === "national") counts.nationalAnalysts++;
      else if (user.readScope === "province") counts.provincialAnalysts++;
      else counts.districtAnalysts++;
    }
    return {
      configured: accounts.length, inserted: result.upsertedCount,
      preserved: before.size, verified: after.length, counts, preservedAssignmentsDiffer,
    };
  });
}

async function main() {
  let connected = false;
  try {
    const env = loadUserEnvironment();
    loadAccounts(env);
    await connectDatabase();
    connected = true;
    console.log(JSON.stringify(await seedUsers({ env }), null, 2));
    console.log("User seed committed; all configured accounts verified.");
  } catch (error) {
    // Only our sanitized diagnostics may reach logs, never driver/validation objects.
    const reason = error instanceof SeedUsersError ? error.message
      : error.code === 11000 ? "Duplicate account identity; no existing accounts were changed."
        : "Database connection or transaction failed; check MongoDB connectivity and transaction support.";
    console.error(`User seed failed: ${reason}`);
    process.exitCode = 1;
  } finally {
    try {
      await disconnectDatabase();
      if (connected) console.log("MongoDB disconnected");
    } catch {
      console.error("Unable to disconnect MongoDB.");
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
module.exports = { accountDefinitions, loadAccounts, seedUsers };
