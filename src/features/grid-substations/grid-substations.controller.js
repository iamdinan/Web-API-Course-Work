const { sendPrivateJson } = require("../../utils/response-validators");
const substations = require("./grid-substations.service");
const { sendError } = require("../../utils/http-errors");

async function getSubstation(req, res) {
  let body;
  try {
    body = await substations.findSubstation(req.user, req.params.substationId);
  } catch (error) {
    if (!(error instanceof substations.SubstationAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Substation not found.", details: [] });
  // Express evaluates freshness after current access checks; no reliable change time exists.
  return sendPrivateJson(res, body, { user: req.user, body });
}

async function getDistrictSubstations(req, res) {
  let body;
  try {
    body = await substations.listDistrictSubstations(req.user, req.params.districtId);
  } catch (error) {
    if (!(error instanceof substations.SubstationAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "District not found.", details: [] });
  return sendPrivateJson(res, body, {
    user: req.user, districtId: req.params.districtId, body,
  });
}

module.exports = { getSubstation, getDistrictSubstations };
