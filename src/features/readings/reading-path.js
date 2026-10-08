const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");

function publicPath(parameter) {
  return function validate(req, res, next) {
    if (typeof req.params[parameter] !== "string" || !publicUuid.test(req.params[parameter])) {
      return sendError(res, 400, { code: "INVALID_REQUEST", message: `${parameter} must be a public UUID.`, details: [] });
    }
    next();
  };
}
const validateInstallationPath = publicPath("installationId");
const validateSubstationPath = publicPath("substationId");

function validateReadingPath(req, res, next) {
  if (![req.params.installationId, req.params.readingId].every(id => typeof id === "string" && publicUuid.test(id))) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "installationId and readingId must be public UUIDs.", details: [] });
  }
  next();
}

module.exports = { validateReadingPath, validateInstallationPath, validateSubstationPath };
