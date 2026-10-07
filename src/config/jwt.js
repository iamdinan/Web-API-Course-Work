require("./env");

const signingKey = process.env.JWT_SIGNING_KEY;
const issuer = process.env.JWT_ISSUER;
const audience = process.env.JWT_AUDIENCE;
const expiresIn = Number(process.env.JWT_EXPIRES_IN_SECONDS ?? 900);

if (typeof signingKey !== "string" || Buffer.byteLength(signingKey) < 32) {
  throw new Error("JWT_SIGNING_KEY must contain at least 32 bytes.");
}
if (!issuer?.trim() || !audience?.trim()) {
  throw new Error("JWT_ISSUER and JWT_AUDIENCE are required.");
}
if (!Number.isInteger(expiresIn) || expiresIn < 60 || expiresIn > 3600) {
  throw new Error("JWT_EXPIRES_IN_SECONDS must be an integer from 60 to 3600.");
}

module.exports = Object.freeze({ signingKey, issuer, audience, expiresIn, algorithm: "HS256" });
