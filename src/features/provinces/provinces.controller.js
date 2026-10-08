const { sendPrivateJson } = require("../../utils/response-validators");
const provinces = require("./provinces.service");
const { sendError } = require("../../utils/http-errors");

async function getProvince(req, res) {
  let body;
  try {
    body = await provinces.findProvince(req.user, req.params.provinceId);
  } catch (error) {
    if (!(error instanceof provinces.ProvinceAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Province not found.", details: [] });
  return sendPrivateJson(res, body, { user: req.user, body });
}

async function getProvinces(req, res) {
  let body;
  try {
    body = await provinces.listProvinces(req.user, req.provinceQuery);
  } catch (error) {
    if (!(error instanceof provinces.ProvinceFilterConflict)) throw error;
    return res.status(400).json({ code: "INVALID_QUERY", message: "Geographic filters have conflicting ancestry.", details: [] });
  }
  // The scoped principal participates in the validator even for identical bodies.
  return sendPrivateJson(res, body, { user: req.user, body });
}

module.exports = { getProvinces, getProvince };
