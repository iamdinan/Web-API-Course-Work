const { tokenRequest } = require("./token-request");

const validateDeviceTokenRequest = tokenRequest({
  fields: ["meterId", "deviceSecret"],
  valid: () => true,
  message: "Provide only a nonempty meterId and deviceSecret.",
  attach(req, body) {
    req.deviceCredentials = { meterId: body.meterId, deviceSecret: body.deviceSecret };
  },
});

module.exports = { validateDeviceTokenRequest };
