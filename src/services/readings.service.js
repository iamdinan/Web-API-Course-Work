const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { SolarInstallation, GenerationReading } = require("../models");

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
      return reading.toJSON();
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.installationId && error.keyPattern?.recordedAt) {
      throw new ReadingWriteError(409, "DUPLICATE_READING", "A reading already exists for this installation and recordedAt.");
    }
    throw error;
  }
}

module.exports = { createReading, ReadingWriteError };
