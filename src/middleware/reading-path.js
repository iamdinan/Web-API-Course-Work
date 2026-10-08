const { publicUuid } = require("../services/user-principal");

function validateReadingPath(req, res, next) {
  if (![req.params.installationId, req.params.readingId].every(id => typeof id === "string" && publicUuid.test(id))) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "installationId and readingId must be public UUIDs.", details: [] });
  }
  next();
}

module.exports = { validateReadingPath };
