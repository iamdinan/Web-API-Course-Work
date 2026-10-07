const mongoose = require("mongoose");
const { createHash } = require("node:crypto");

// Operational counters, separate from public domain models. Logical expiry is
// atomic; TTL cleanup is only storage maintenance and need not run immediately.
const schema = new mongoose.Schema({
  _id: String, count: Number, expiresAt: Date,
}, { versionKey: false });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Counter = mongoose.model("TokenRateLimit", schema, "token_rate_limits");

async function consume(kind, identity) {
  const key = `${kind}:${createHash("sha256").update(identity).digest("hex")}`;
  const expired = { $lte: [{ $ifNull: ["$expiresAt", new Date(0)] }, "$$NOW"] };
  await Counter.init();
  const update = () => Counter.findOneAndUpdate({ _id: key }, [{ $set: {
    count: { $cond: [expired, 1, { $add: ["$count", 1] }] },
    expiresAt: { $cond: [expired, { $add: ["$$NOW", 15 * 60 * 1000] }, "$expiresAt"] },
  } }], { upsert: true, returnDocument: "after", updatePipeline: true }).lean();
  let counter;
  try { counter = await update(); }
  catch (error) {
    // Concurrent first upserts may collide on the unique key; increment the winner.
    if (error.code !== 11000) throw error;
    counter = await update();
  }
  return counter.count > 5 ? Math.max(1, Math.ceil((counter.expiresAt.getTime() - Date.now()) / 1000)) : 0;
}

async function checkUserTokenLimit(ip, email) {
  const retryAfter = await consume("user-token-ip", ip);
  if (retryAfter) return retryAfter;
  return consume("user-token-account", email);
}

module.exports = { checkUserTokenLimit, Counter };
