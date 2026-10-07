const mongoose = require("mongoose");
const { randomBytes, scrypt, randomUUID } = require("node:crypto");
const { promisify } = require("node:util");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const models = require("../src/models");
const { createSites, generateReadings, EXPECTED, SAMPLES } = require("./seed-data");
const scryptAsync = promisify(scrypt);

async function credentialHash(secret) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(secret || randomBytes(32).toString("hex"), salt, 64);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function insertIfMissing(Model, filter, fields, session) {
  const matches = await Model.find(filter).session(session).limit(2);
  if (matches.length > 1) throw new Error(`Ambiguous ${Model.modelName} seed identity.`);
  if (matches.length) return matches[0];
  const document = new Model(fields);
  document.$session(session);
  // save() runs full validation, including parent existence checks.
  await document.save({ session });
  return document;
}

async function seedHierarchy(sites, onProgress = () => {}) {
  const installations = [];
  for (const site of sites) {
    const siteInstallations = await mongoose.connection.transaction(async session => {
      const resolved = [];
      const province = await insertIfMissing(models.Province, { name: site.provinceName }, { name: site.provinceName }, session);
      const districtFields = { name: site.districtName, provinceId: province.publicId };
      const district = await insertIfMissing(models.District, districtFields, districtFields, session);
      const substationFields = { name: site.substationName, districtId: district.publicId };
      const substation = await insertIfMissing(models.GridSubstation, substationFields, substationFields, session);
      for (const profile of site.installations) {
        let installation = await models.SolarInstallation.findOne({ meterId: profile.meterId }).session(session);
        if (installation) {
          if (installation.substationId !== substation.publicId) throw new Error("Seed meter has a conflicting parent.");
        } else {
          installation = new models.SolarInstallation({
            meterId: profile.meterId, substationId: substation.publicId, status: "active",
            deviceCredentialHash: await credentialHash(process.env[`SEED_DEVICE_SECRET_${profile.profileIndex + 1}`]),
          });
          await installation.save({ session });
        }
        resolved.push({ publicId: installation.publicId, profileIndex: profile.profileIndex });
      }
      return resolved;
    });
    installations.push(...siteInstallations);
    onProgress({ district: site.districtName, installationCount: installations.length });
  }
  return installations;
}

async function insertReadingBatch(batch) {
  if (!batch.length) return 0;
  const installationId = batch[0].installationId;
  if (batch.length > 1000 || batch.some(reading => reading.installationId !== installationId)) {
    throw new Error("A reading batch must contain at most 1,000 samples for one installation.");
  }
  // Setup-only raw bulk writes bypass the model's general bulkWrite ban.
  // Only $setOnInsert is used, so existing history can never be overwritten.
  return mongoose.connection.transaction(async session => {
    const timestamps = batch.map(reading => +reading.recordedAt);
    const existing = await models.GenerationReading.collection.find({
      installationId,
      recordedAt: { $gte: new Date(Math.min(...timestamps)), $lte: new Date(Math.max(...timestamps)) },
    }, { projection: { recordedAt: 1 }, session }).toArray();
    const existingTimes = new Set(existing.map(reading => +reading.recordedAt));
    const missing = batch.filter(reading => !existingTimes.has(+reading.recordedAt));
    if (!missing.length) return 0;
    // Coordinate with installation deletion without changing public fields.
    const parent = await models.SolarInstallation.collection.updateOne(
      { publicId: installationId, _seedBatchLock: { $exists: false } },
      { $set: { _seedBatchLock: randomUUID() } }, { session },
    );
    if (parent.matchedCount !== 1) throw new Error("Seed reading parent disappeared.");
    const operations = [];
    for (const fields of missing) {
      const document = new models.GenerationReading(fields);
      // Parent existence was checked once for the batch under write locks.
      await document.validate(["publicId", "recordedAt", "receivedAt", "powerKw", "energyKwh", "voltageV"]);
      const insert = document.toObject();
      delete insert._id;
      delete insert.__v;
      operations.push({ updateOne: {
        filter: { installationId: fields.installationId, recordedAt: fields.recordedAt },
        update: { $setOnInsert: insert }, upsert: true,
      } });
    }
    const result = await models.GenerationReading.collection.bulkWrite(operations, { ordered: true, session });
    await models.SolarInstallation.collection.updateOne(
      { publicId: installationId }, { $unset: { _seedBatchLock: "" } }, { session },
    );
    return result.upsertedCount;
  });
}

async function seedFullDataset({ sites = createSites(), onProgress = () => {} } = {}) {
  for (const Model of Object.values(models)) await Model.createIndexes();
  const installations = await seedHierarchy(sites, onProgress);
  let inserted = 0;
  let processed = 0;
  for (const installation of installations) {
    const batch = [...generateReadings(installation.publicId, installation.profileIndex)];
    inserted += await insertReadingBatch(batch);
    processed += batch.length;
    onProgress({ processed, inserted });
  }
  return { installations, processed, inserted };
}

async function collectionCounts() {
  const counts = {};
  for (const Model of Object.values(models)) counts[Model.collection.collectionName] = await Model.countDocuments({});
  return counts;
}

async function main() {
  try {
    await connectDatabase();
    const result = await seedFullDataset({ onProgress: ({ processed, inserted, district, installationCount }) => {
      if (district) console.log(`Hierarchy ready: ${district}; installations: ${installationCount}`);
      if (processed > 0 && (processed % (SAMPLES * 20) === 0 || processed === EXPECTED.generation_readings)) console.log(`Readings processed: ${processed}; inserted: ${inserted}`);
    } });
    console.log(`Full seed complete. Inserted ${result.inserted} readings. Collection totals:`);
    console.log(JSON.stringify(await collectionCounts(), null, 2));
  } catch (error) {
    console.error(`Seed failed (${error.code === 11000 ? "duplicate key" : error.name}). No database reset performed.`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
    console.log("MongoDB disconnected");
  }
}

if (require.main === module) main();
module.exports = { seedFullDataset, seedHierarchy, insertReadingBatch };
