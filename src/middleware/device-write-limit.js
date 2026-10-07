const limits = require("../services/token-rate-limit.service");

async function deviceWriteLimit(req, res, next) {
  const retryAfter = await limits.checkDeviceWriteLimit(req.ip, req.installation.id);
  if (retryAfter) {
    return res.set("Retry-After", String(retryAfter)).status(429).json({
      code: "RATE_LIMIT_EXCEEDED", message: "Too many reading submissions. Try again later.", details: [],
    });
  }
  next();
}

module.exports = { deviceWriteLimit };
