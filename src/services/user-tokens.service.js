const { scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const jwt = require("jsonwebtoken");
const { User } = require("../models");
const config = require("../config/jwt");
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
  const province = user.provinceId != null;
  const district = user.districtId != null;
  const validScope = (user.readScope === "national" && !province && !district) ||
    (user.readScope === "province" && province && !district) ||
    (user.readScope === "district" && district && !province);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!validScope || !["user", "admin"].includes(user.role) ||
      (user.role === "admin" && user.readScope !== "national") || !uuid.test(user.publicId) ||
      (province && !uuid.test(user.provinceId)) || (district && !uuid.test(user.districtId))) {
    throw new Error("Invalid stored user authorization.");
  }
  const claims = { actor: "user", role: user.role, readScope: user.readScope };
  if (province) claims.provinceId = user.provinceId;
  if (district) claims.districtId = user.districtId;
  if (user.role === "admin") claims.permissions = ["installation-create", "installation-deactivate", "installation-delete"];
  return {
    access_token: jwt.sign(claims, config.signingKey, {
      algorithm: config.algorithm, subject: user.publicId, issuer: config.issuer,
      audience: config.audience, expiresIn: config.expiresIn,
    }),
    token_type: "Bearer", expires_in: config.expiresIn,
  };
}

module.exports = { issueUserToken, verifyPassword };
