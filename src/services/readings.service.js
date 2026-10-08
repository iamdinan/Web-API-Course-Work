const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { SolarInstallation, GenerationReading, GridSubstation, District, Province } = require("../models");
const { publicUuid } = require("./user-principal");

function readingBody(document) {
  const value = document.toJSON();
  // Keep POST and GET byte-identical regardless of persisted field order, and
  // allow only the public reading fields into the representation/validator.
  return {
    installationId: value.installationId, recordedAt: value.recordedAt,
    powerKw: value.powerKw, energyKwh: value.energyKwh, voltageV: value.voltageV,
    receivedAt: value.receivedAt, id: value.id,
  };
}

async function findReading(user, installationId, readingId) {
  const installation = await SolarInstallation.findOne({ publicId: installationId }).select("substationId -_id").lean();
  if (!installation || !publicUuid.test(installation.substationId)) return null;
  const substation = await GridSubstation.findOne({ publicId: installation.substationId }).select("districtId -_id").lean();
  if (!substation || !publicUuid.test(substation.districtId)) return null;
  const district = await District.findOne({ publicId: substation.districtId }).select("provinceId -_id").lean();
  if (!district || !publicUuid.test(district.provinceId)) return null;
  const province = await Province.findOne({ publicId: district.provinceId }).select("publicId -_id").lean();
  if (!province) return null;
  if ((user.readScope === "province" && district.provinceId !== user.provinceId) ||
      (user.readScope === "district" && substation.districtId !== user.districtId) ||
      !["national", "province", "district"].includes(user.readScope)) {
    throw new ReadingAccessError();
  }
  // Scope is established before loading the reading. Bind BOTH URL identities.
  const reading = await GenerationReading.findOne({ publicId: readingId, installationId })
    .select("publicId installationId recordedAt powerKw energyKwh voltageV receivedAt -_id");
  return reading ? readingBody(reading) : null;
}

class ReadingAccessError extends Error {
  constructor() {
    super("The installation is outside your permitted jurisdiction.");
  }
}

class ReadingWriteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function createReading(installationId, input) {
  // Initialize indexes before opening the transaction, including timestamp uniqueness.
  await GenerationReading.init();
  try {
    return await mongoose.connection.transaction(async session => {
      // A real write (not a snapshot-only check or no-op update) conflicts with
      // lifecycle writes on this same document. Transaction retries recheck status.
      const parent = await SolarInstallation.updateOne(
        { publicId: installationId, status: "active" },
        { $set: { _ingestionLock: randomUUID() } }, { session },
      );
      if (parent.matchedCount !== 1) {
        const current = await SolarInstallation.findOne({ publicId: installationId }).select("status").session(session).lean();
        if (current?.status === "inactive") {
          throw new ReadingWriteError(403, "INSTALLATION_INACTIVE", "Inactive installations cannot authenticate for writes.");
        }
        throw new ReadingWriteError(401, "UNAUTHORIZED", "A valid installation bearer token is required.");
      }
      const reading = new GenerationReading({ ...input, installationId, receivedAt: new Date() });
      await reading.save({ session });
      await SolarInstallation.updateOne({ publicId: installationId }, { $unset: { _ingestionLock: "" } }, { session });
      return readingBody(reading);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.installationId && error.keyPattern?.recordedAt) {
      throw new ReadingWriteError(409, "DUPLICATE_READING", "A reading already exists for this installation and recordedAt.");
    }
    throw error;
  }
}

module.exports = { createReading, findReading, ReadingWriteError, ReadingAccessError };
