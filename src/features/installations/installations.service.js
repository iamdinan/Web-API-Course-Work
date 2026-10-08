const { GridSubstation, SolarInstallation } = require("../../models");
const { hashPassword } = require("../../services/passwords");
const { installationBody } = require("../readings/readings.serializer");

class InstallationCreateError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function createInstallation({ substationId, meterId, deviceSecret }) {
  if (!await GridSubstation.exists({ publicId: substationId })) {
    throw new InstallationCreateError(404, "NOT_FOUND", "Grid substation not found.");
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
      throw new InstallationCreateError(409, "DUPLICATE_METER_ID", "Meter ID already exists.");
    }
    throw error;
  }
}
module.exports = { createInstallation, InstallationCreateError };
