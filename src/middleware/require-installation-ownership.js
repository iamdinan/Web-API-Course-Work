const { publicUuid } = require("../services/user-principal");

function requireInstallationOwnership(req, res, next) {
  if (typeof req.installation?.id !== "string" || !publicUuid.test(req.installation.id)) {
    return res.set("WWW-Authenticate", "Bearer").status(401).json({
      code: "UNAUTHORIZED", message: "A valid installation bearer token is required.", details: [],
    });
  }
  if (req.params?.installationId !== req.installation.id) {
    return res.status(403).json({
      code: "FORBIDDEN", message: "The authenticated installation cannot access this installation.", details: [],
    });
  }
  next();
}

module.exports = { requireInstallationOwnership };
