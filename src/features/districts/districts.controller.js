const { sendPrivateJson } = require("../../utils/response-validators");
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
  // Access precedes Express freshness handling; no reliable metadata change time exists.
  return sendPrivateJson(res, body, { user: req.user, body });
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
  return sendPrivateJson(res, body, { user: req.user, provinceId: req.params.provinceId, body });
}

module.exports = { getDistrict, getProvinceDistricts };
