const { verifyBearerToken } = require("../services/verify-bearer-token");
const { SolarInstallation } = require("../models");

function unauthorized(res) {
  return res.set("WWW-Authenticate", "Bearer").status(401).json({
    code: "UNAUTHORIZED", message: "A valid installation bearer token is required.", details: [],
  });
}

async function verifyInstallationJwt(req, res, next) {
  const claims = verifyBearerToken(req.headers.authorization);
  if (!claims || claims.actor !== "installation") return unauthorized(res);
  if (claims.scope !== "installation-write") {
    return res.status(403).json({
      code: "FORBIDDEN", message: "The token does not permit installation writes.", details: [],
    });
  }
  // Read current state, excluding credentials; stale status/identity claims cannot grant access.
  const installation = await SolarInstallation.findOne({ publicId: claims.sub }).select("publicId status").lean();
  if (!installation || installation.publicId !== claims.sub) return unauthorized(res);
  if (installation.status === "inactive") {
    return res.status(403).json({
      code: "INSTALLATION_INACTIVE", message: "Inactive installations cannot authenticate for writes.", details: [],
    });
  }
  if (installation.status !== "active") return unauthorized(res);
  req.installation = Object.freeze({ id: installation.publicId });
  next();
}

module.exports = { verifyInstallationJwt };
