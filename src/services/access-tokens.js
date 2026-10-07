const jwt = require("jsonwebtoken");
const config = require("../config/jwt");

function signAccessToken(subject, claims) {
  return {
    access_token: jwt.sign(claims, config.signingKey, {
      algorithm: config.algorithm, subject, issuer: config.issuer,
      audience: config.audience, expiresIn: config.expiresIn,
    }),
    token_type: "Bearer", expires_in: config.expiresIn,
  };
}

module.exports = { signAccessToken };
