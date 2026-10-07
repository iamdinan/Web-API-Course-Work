const tokens = require("../services/user-tokens.service");
const limits = require("../services/token-rate-limit.service");

async function createUserToken(req, res) {
  const { email, password } = req.userCredentials;
  const retryAfter = await limits.checkUserTokenLimit(req.ip, email);
  if (retryAfter) {
    return res.set("Retry-After", String(retryAfter)).status(429).json({
      code: "RATE_LIMIT_EXCEEDED", message: "Too many login attempts. Try again later.", details: [],
    });
  }
  const token = await tokens.issueUserToken(email, password);
  if (!token) {
    return res.set("WWW-Authenticate", "Bearer").status(401).json({
      code: "INVALID_CREDENTIALS", message: "Invalid email or password.", details: [],
    });
  }
  // Avoid Express's application-wide ETag generation for credential responses.
  res.status(200).type("json").end(JSON.stringify(token));
}

module.exports = { createUserToken };
