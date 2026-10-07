const { scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const jwt = require("jsonwebtoken");
const { User } = require("../models");
const config = require("../config/jwt");
const { currentUserPrincipal } = require("./user-principal");
const scryptAsync = promisify(scrypt);
const dummyHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

async function verifyPassword(password, storedHash) {
  const validFormat = typeof storedHash === "string" && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(storedHash);
  const [, salt, hash] = (validFormat ? storedHash : dummyHash).split("$");
  const derived = await scryptAsync(password, salt, 64);
  const matches = timingSafeEqual(derived, Buffer.from(hash, "hex"));
  return validFormat && matches;
}

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
