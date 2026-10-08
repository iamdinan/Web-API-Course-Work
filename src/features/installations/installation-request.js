const { tokenRequest } = require("../auth/token-request");
const { publicUuid } = require("../../services/user-principal");

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
module.exports = { validateInstallationRequest, validateStatusRequest };
