const limits = require("../services/token-rate-limit.service");
const { sendError } = require("../utils/http-errors");

async function userReadLimit(req, res, next) {
  const retryAfter = await limits.checkUserReadLimit(req.user.id);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return sendError(res, 429, {
      code: "RATE_LIMIT_EXCEEDED", message: "Too many read requests. Try again later.", details: [],
    });
  }
  next();
}

async function deviceWriteLimit(req, res, next) {
  const retryAfter = await limits.checkDeviceWriteLimit(req.ip, req.installation.id);
  if (retryAfter) {
    return res.set("Retry-After", String(retryAfter)).status(429).json({
      code: "RATE_LIMIT_EXCEEDED", message: "Too many reading submissions. Try again later.", details: [],
    });
  }
  next();
}

async function adminWriteLimit(req, res, next) {
  const retryAfter = await limits.checkAdminWriteLimit(req.user.id);
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return sendError(res, 429, { code: "RATE_LIMIT_EXCEEDED", message: "Too many installation writes. Try again later.", details: [] });
  }
  next();
}

module.exports = { userReadLimit, deviceWriteLimit, adminWriteLimit };
