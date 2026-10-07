const limits = require("../services/token-rate-limit.service");

async function userReadLimit(req, res, next) {
  const retryAfter = await limits.checkUserReadLimit(req.user.id);
  if (retryAfter) {
    return res.set("Retry-After", String(retryAfter)).status(429).json({
      code: "RATE_LIMIT_EXCEEDED", message: "Too many read requests. Try again later.", details: [],
    });
  }
  next();
}

module.exports = { userReadLimit };
