const { sendError } = require("../utils/http-errors");

function requireAdmin(req, res, next) {
  if (req.user.role !== "admin") {
    return sendError(res, 403, { code: "FORBIDDEN", message: "An administrator is required.", details: [] });
  }
  next();
}
module.exports = { requireAdmin };
