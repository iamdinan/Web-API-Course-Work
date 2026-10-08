const { tokenRequest } = require("../auth/token-request");
const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");

const validateInstallationRequest = tokenRequest({
  fields: ["substationId", "meterId", "deviceSecret"],
  valid: body => publicUuid.test(body.substationId),
  message: "Provide only a valid substationId UUID v4 and nonempty meterId and deviceSecret strings.",
  attach(req, body) {
    req.installationInput = { substationId: body.substationId, meterId: body.meterId.trim(), deviceSecret: body.deviceSecret };
  },
});
const validateStatusRequest = tokenRequest({
  fields: ["status"],
  valid: body => ["active", "inactive"].includes(body.status),
  message: 'Provide only status with value "active" or "inactive".',
  attach(req, body) { req.installationStatus = body.status; },
});
function validateDeletionRequest(req, res, next) {
  // express.json does not parse other media types. Check framing as well so
  // text/binary/chunked bodies cannot bypass the bodyless DELETE contract.
  if (req.body !== undefined || Number(req.headers["content-length"] || 0) > 0 || req.headers["transfer-encoding"]) {
    return sendError(res, 400, { code: "INVALID_REQUEST", message: "DELETE requests must not contain a body.", details: [] });
  }
  next();
}
module.exports = { validateInstallationRequest, validateStatusRequest, validateDeletionRequest };
