const installations = require("./installations.service");
const { installationETag } = require("../readings/readings.serializer");
const { apiBaseUrl } = require("../../config/env");
const { sendError } = require("../../utils/http-errors");

async function postInstallation(req, res) {
  try {
    const body = await installations.createInstallation(req.installationInput);
    return res.set({ Location: `${apiBaseUrl}/installations/${body.id}`, ETag: installationETag(body) }).status(201).json(body);
  } catch (error) {
    if (!(error instanceof installations.InstallationWriteError)) throw error;
    return sendError(res, error.status, { code: error.code, message: error.message, details: [] });
  }
}
async function patchInstallation(req, res) {
  try {
    const body = await installations.updateInstallationStatus(req.params.installationId, req.installationStatus, req.headers["if-match"]);
    return res.set("ETag", installationETag(body)).status(200).json(body);
  } catch (error) {
    if (!(error instanceof installations.InstallationWriteError)) throw error;
    return sendError(res, error.status, { code: error.code, message: error.message, details: [] });
  }
}
module.exports = { postInstallation, patchInstallation };
