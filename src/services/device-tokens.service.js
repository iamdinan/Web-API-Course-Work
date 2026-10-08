const { SolarInstallation } = require("../models");
const { verifyPassword } = require("./passwords");
const { signAccessToken } = require("./access-tokens");
const { publicUuid } = require("./user-principal");

async function issueDeviceToken(meterId, deviceSecret) {
  const installation = await SolarInstallation.findOne({ meterId })
    .select("publicId status +deviceCredentialHash").lean();
  // Unknown meters still perform the shared dummy password derivation.
  if (!await verifyPassword(deviceSecret, installation?.deviceCredentialHash)) return null;
  if (installation.status === "inactive") return { inactive: true };
  if (installation.status !== "active" || !publicUuid.test(installation.publicId)) {
    throw new Error("Invalid stored installation identity or status.");
  }
  return {
    ...signAccessToken(installation.publicId, { actor: "installation", scope: "installation-write" }),
    installationId: installation.publicId,
  };
}

module.exports = { issueDeviceToken };
