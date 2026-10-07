const jwt = require("jsonwebtoken");
const config = require("../config/jwt");
const { User } = require("../models");
const { currentUserPrincipal, publicUuid } = require("../services/user-principal");

function unauthorized(res) {
  return res.set("WWW-Authenticate", "Bearer").status(401).json({
    code: "UNAUTHORIZED", message: "A valid user bearer token is required.", details: [],
  });
}

async function verifyUserJwt(req, res, next) {
  const header = req.headers.authorization;
  const match = typeof header === "string" && /^Bearer +([^\s,]+)$/i.exec(header.trim());
  if (!match) return unauthorized(res);
  let claims;
  try {
    claims = jwt.verify(match[1], config.signingKey, {
      algorithms: [config.algorithm], issuer: config.issuer, audience: config.audience,
    });
  } catch {
    return unauthorized(res);
  }
  if (typeof claims !== "object" || claims.actor !== "user" || typeof claims.sub !== "string" ||
      !publicUuid.test(claims.sub) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.exp <= claims.iat || claims.exp - claims.iat > 3600) return unauthorized(res);
  // Database errors propagate as sanitized 500s, rather than credential errors.
  const user = await User.findOne({ publicId: claims.sub }).select("publicId role readScope provinceId districtId").lean();
  const principal = currentUserPrincipal(user);
  if (!principal) return unauthorized(res);
  // Never copy role, permissions, or jurisdiction from stale token claims.
  req.user = principal;
  next();
}

module.exports = { verifyUserJwt };
