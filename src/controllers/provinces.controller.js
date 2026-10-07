const { createHash } = require("node:crypto");
const provinces = require("../services/provinces.service");

async function getProvinces(req, res) {
  let body;
  try {
    body = await provinces.listProvinces(req.user, req.provinceQuery);
  } catch (error) {
    if (!(error instanceof provinces.ProvinceFilterConflict)) throw error;
    return res.status(400).json({ code: "INVALID_QUERY", message: "Geographic filters have conflicting ancestry.", details: [] });
  }
  // The scoped principal participates in the validator even for identical bodies.
  const tag = createHash("sha256").update(JSON.stringify({ user: req.user, body })).digest("hex");
  res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

module.exports = { getProvinces };
