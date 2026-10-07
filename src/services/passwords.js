const { randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const scryptAsync = promisify(scrypt);
const dummyHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

async function hashPassword(password) {
  if (typeof password !== "string" || !password.trim()) throw new Error("A nonempty password is required.");
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const validFormat = typeof storedHash === "string" && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(storedHash);
  const [, salt, hash] = (validFormat ? storedHash : dummyHash).split("$");
  const derived = await scryptAsync(password, salt, 64);
  const matches = timingSafeEqual(derived, Buffer.from(hash, "hex"));
  return validFormat && matches;
}

module.exports = { hashPassword, verifyPassword };
