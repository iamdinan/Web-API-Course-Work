const tokens = require("./device-tokens.service");
const limits = require("../../services/token-rate-limit.service");

async function createDeviceToken(req, res) {
  const { meterId, deviceSecret } = req.deviceCredentials;
  const retryAfter = await limits.checkDeviceTokenLimit(req.ip, meterId);
  if (retryAfter) {
    return res.set("Retry-After", String(retryAfter)).status(429).json({
      code: "RATE_LIMIT_EXCEEDED", message: "Too many login attempts. Try again later.", details: [],
    });
  }
  const token = await tokens.issueDeviceToken(meterId, deviceSecret);
  if (!token) {
    return res.set("WWW-Authenticate", "Bearer").status(401).json({
      code: "INVALID_CREDENTIALS", message: "Invalid meter ID or device secret.", details: [],
    });
  }
  if (token.inactive) {
    return res.status(403).json({
      code: "INSTALLATION_INACTIVE", message: "Inactive installations cannot obtain device tokens.", details: [],
    });
  }
  res.status(200).type("json").end(JSON.stringify(token));
}

module.exports = { createDeviceToken };
