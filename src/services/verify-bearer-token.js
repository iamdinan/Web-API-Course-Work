const jwt = require("jsonwebtoken");
const config = require("../config/jwt");
const { publicUuid } = require("./user-principal");

function verifyBearerToken(header) {
  const match = typeof header === "string" && /^Bearer +([^\s,]+)$/i.exec(header.trim());
  if (!match) return null;
  let claims;
  try {
    claims = jwt.verify(match[1], config.signingKey, {
      algorithms: [config.algorithm], issuer: config.issuer, audience: config.audience,
    });
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || typeof claims.sub !== "string" ||
      !publicUuid.test(claims.sub) || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) ||
      claims.exp <= claims.iat || claims.exp - claims.iat > 3600) return null;
  return claims;
}

module.exports = { verifyBearerToken };
