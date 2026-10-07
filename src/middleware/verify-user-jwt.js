const { verifyBearerToken } = require("../services/verify-bearer-token");
const { User } = require("../models");
const { currentUserPrincipal } = require("../services/user-principal");

function unauthorized(res) {
  return res.set("WWW-Authenticate", "Bearer").status(401).json({
    code: "UNAUTHORIZED", message: "A valid user bearer token is required.", details: [],
  });
}

async function verifyUserJwt(req, res, next) {
  const claims = verifyBearerToken(req.headers.authorization);
  if (!claims || claims.actor !== "user") return unauthorized(res);
  // Database errors propagate as sanitized 500s, rather than credential errors.
  const user = await User.findOne({ publicId: claims.sub }).select("publicId role readScope provinceId districtId").lean();
  const principal = currentUserPrincipal(user);
  if (!principal) return unauthorized(res);
  // Never copy role, permissions, or jurisdiction from stale token claims.
  req.user = principal;
  next();
}

module.exports = { verifyUserJwt };
