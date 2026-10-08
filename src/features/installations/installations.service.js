const { GridSubstation, SolarInstallation, GenerationReading } = require("../../models");
const { hashPassword } = require("../../services/passwords");
const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { installationBody, installationETag } = require("../readings/readings.serializer");
const { parseIfMatch, ifMatchAllows } = require("./installation-precondition");

class InstallationWriteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function createInstallation({ substationId, meterId, deviceSecret }) {
  if (!await GridSubstation.exists({ publicId: substationId })) {
    throw new InstallationWriteError(404, "NOT_FOUND", "Grid substation not found.");
  }
  // Initialize the unique meter index before accepting writes, including races.
  await SolarInstallation.init();
  const deviceCredentialHash = await hashPassword(deviceSecret);
  try {
    const installation = await SolarInstallation.create({ substationId, meterId, status: "active", deviceCredentialHash });
    // The model generates the public UUID; serialization excludes credentials.
    return installationBody(installation);
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.meterId) {
      throw new InstallationWriteError(409, "DUPLICATE_METER_ID", "Meter ID already exists.");
    }
    throw error;
  }
}
async function updateInstallationStatus(installationId, status, ifMatch) {
  return mongoose.connection.transaction(async session => {
    await installationForWrite(installationId, ifMatch, session);
    // Force a real parent write even for repeated status updates. This conflicts
    // with ingestion and concurrent lifecycle writes; transaction retries reload
    // the current representation and re-evaluate If-Match inside this callback.
    const updated = await SolarInstallation.findOneAndUpdate(
      { publicId: installationId },
      { $set: { status, _ingestionLock: randomUUID() } },
      { session, returnDocument: "after", runValidators: true },
    ).select("publicId substationId meterId status");
    await SolarInstallation.updateOne({ publicId: installationId }, { $unset: { _ingestionLock: "" } }, { session });
    return installationBody(updated);
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
}

async function installationForWrite(installationId, ifMatch, session) {
  const installation = await SolarInstallation.findOne({ publicId: installationId })
    .select("publicId substationId meterId status").session(session);
  if (!installation) throw new InstallationWriteError(404, "NOT_FOUND", "Installation not found.");
  // Missing resources take precedence over header parsing/comparison.
  let condition;
  try {
    condition = parseIfMatch(ifMatch);
  } catch {
    throw new InstallationWriteError(400, "INVALID_REQUEST", "If-Match must contain a quoted entity-tag list or *.");
  }
  if (!ifMatchAllows(condition, installationETag(installationBody(installation)))) {
    throw new InstallationWriteError(412, "PRECONDITION_FAILED", "The installation does not match If-Match.");
  }
}

async function deleteInstallation(installationId, ifMatch) {
  return mongoose.connection.transaction(async session => {
    await installationForWrite(installationId, ifMatch, session);
    // This real parent write precedes the history guard and conflicts with
    // ingestion on the same installation. A conflict retries both checks.
    await SolarInstallation.updateOne({ publicId: installationId },
      { $set: { _ingestionLock: randomUUID() } }, { session });
    if (await GenerationReading.exists({ installationId }).session(session)) {
      throw new InstallationWriteError(409, "INSTALLATION_HAS_READINGS", "Installations with readings cannot be deleted.");
    }
    await SolarInstallation.deleteOne({ publicId: installationId }, { session });
  }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
}
module.exports = { createInstallation, updateInstallationStatus, deleteInstallation, InstallationWriteError };
