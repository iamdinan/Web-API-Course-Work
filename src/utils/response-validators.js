const { createHash } = require("node:crypto");

function strongETag(value) {
  return `"${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`;
}

// Call only after current access checks and scoped representation construction.
// The caller supplies the exact context and property order used by its validator.
function sendPrivateJson(res, body, context) {
  return res.set({ "Cache-Control": "private, no-cache", ETag: strongETag(context) }).json(body);
}

module.exports = { strongETag, sendPrivateJson };
