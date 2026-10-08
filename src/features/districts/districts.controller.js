const { createHash } = require("node:crypto");
const districts = require("./districts.service");
const { sendError } = require("../../utils/http-errors");

async function getDistrict(req, res) {
  let body;
  try {
    body = await districts.findDistrict(req.user, req.params.districtId);
  } catch (error) {
    if (!(error instanceof districts.DistrictAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "District not found.", details: [] });
  const tag = createHash("sha256").update(JSON.stringify({ user: req.user, body })).digest("hex");
  // Access precedes Express freshness handling; no reliable metadata change time exists.
  return res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

async function getProvinceDistricts(req, res) {
  let body;
  try {
    body = await districts.listProvinceDistricts(req.user, req.params.provinceId);
  } catch (error) {
    if (!(error instanceof districts.DistrictAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Province not found.", details: [] });
  const tag = createHash("sha256").update(JSON.stringify({ user: req.user, provinceId: req.params.provinceId, body })).digest("hex");
  return res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

module.exports = { getDistrict, getProvinceDistricts };
