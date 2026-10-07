const mongoose = require("mongoose");
const { randomBytes, scrypt } = require("node:crypto");
const { promisify } = require("node:util");
const { connectDatabase, disconnectDatabase } = require("../src/config/database");
const models = require("../src/models");
const data = require("./seed-data");
const scryptAsync = promisify(scrypt);

async function credentialHash(secret) {
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(secret || randomBytes(32).toString("hex"), salt, 64);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function insertIfMissing(Model, filter, fields, session) {
  const existing = await Model.findOne(filter).session(session);
  if (existing) return existing;
  const document = new Model(fields);
  document.$session(session);
  await document.validate();
  const insert = document.toObject();
  delete insert._id;
  delete insert.__v;
  await Model.updateOne(filter, { $setOnInsert: insert }, {
    upsert: true, runValidators: true, session,
  });
  return document;
}

async function seedSmallDataset(fixture = data) {
  // Build declared indexes before starting the transaction; never drop indexes.
  for (const Model of Object.values(models)) await Model.createIndexes();

  await mongoose.connection.transaction(async session => {
    const province = await insertIfMissing(models.Province, { name: fixture.province.name }, fixture.province, session);
    const districtFields = { ...fixture.district, provinceId: province.publicId };
    const district = await insertIfMissing(models.District, {
      name: districtFields.name, provinceId: province.publicId,
    }, districtFields, session);
    const substationFields = { ...fixture.substation, districtId: district.publicId };
    const substation = await insertIfMissing(models.GridSubstation, {
      name: substationFields.name, districtId: district.publicId,
    }, substationFields, session);
    const installationIds = new Map();

    for (const [index, installation] of fixture.installations.entries()) {
      const existing = await models.SolarInstallation.findOne({ meterId: installation.meterId }).session(session);
      if (existing) {
        if (existing.substationId !== substation.publicId) {
          throw new Error("Seed installation identity conflicts with existing data.");
        }
        // Keep the stored status and credential hash, even if inactive or rotated.
        installationIds.set(installation.publicId, existing.publicId);
        continue;
      }
      const stored = await insertIfMissing(models.SolarInstallation, { meterId: installation.meterId }, {
        ...installation,
        substationId: substation.publicId,
        deviceCredentialHash: await credentialHash(process.env[`SEED_DEVICE_SECRET_${index + 1}`]),
      }, session);
      installationIds.set(installation.publicId, stored.publicId);
    }

    for (const reading of fixture.readings) {
      const fields = { ...reading, installationId: installationIds.get(reading.installationId) };
      await insertIfMissing(models.GenerationReading, {
        installationId: fields.installationId, recordedAt: fields.recordedAt,
      }, fields, session);
    }
  });
}

async function main() {
  try {
    await connectDatabase();
    await seedSmallDataset();
    console.log("Small seed complete. Collection totals:");
    for (const Model of Object.values(models)) {
      console.log(`  ${Model.collection.collectionName}: ${await Model.countDocuments({})}`);
    }
  } catch (error) {
    // Validation/driver errors may contain values or connection details.
    console.error(`Seed failed (${error.code === 11000 ? "duplicate key" : error.name}). Check configuration, references, and database access.`);
    process.exitCode = 1;
  } finally {
    try {
      await disconnectDatabase();
      console.log("MongoDB disconnected");
    } catch {
      console.error("Unable to close MongoDB connection.");
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main();
module.exports = { seedSmallDataset };
