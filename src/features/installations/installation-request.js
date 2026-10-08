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
module.exports = { validateInstallationRequest };
