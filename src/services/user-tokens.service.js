const jwt = require("jsonwebtoken");
const { User } = require("../models");
const config = require("../config/jwt");
const { currentUserPrincipal } = require("./user-principal");
const { verifyPassword } = require("./passwords");

async function issueUserToken(email, password) {
  const user = await User.findOne({ email }).select("publicId role readScope provinceId districtId +passwordHash").lean();
  // Unknown users and invalid stored hash formats still perform password derivation.
  if (!await verifyPassword(password, user?.passwordHash)) return null;
  const principal = currentUserPrincipal(user);
  if (!principal) throw new Error("Invalid stored user authorization.");
  const { id, ...authorization } = principal;
  const claims = { actor: "user", ...authorization };
  return {
    access_token: jwt.sign(claims, config.signingKey, {
      algorithm: config.algorithm, subject: id, issuer: config.issuer,
      audience: config.audience, expiresIn: config.expiresIn,
    }),
    token_type: "Bearer", expires_in: config.expiresIn,
  };
}

module.exports = { issueUserToken, verifyPassword };
