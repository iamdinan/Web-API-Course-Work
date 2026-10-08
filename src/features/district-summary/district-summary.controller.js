const { sendPrivateJson } = require("../../utils/response-validators");
const summary = require("./district-summary.service");
const { sendError } = require("../../utils/http-errors");

const summaryClock = { now: () => new Date() };
async function getDistrictSummary(req, res) {
  // Capture once outside the transaction callback, including transaction retries.
  const asOf = summaryClock.now();
  let body;
  try { body = await summary.summarizeDistrict(req.user, req.query.districtId, asOf); }
  catch (error) {
    if (!(error instanceof summary.SummaryAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "District not found.", details: [] });
  // asOf belongs to the representation: freshness expiry and midnight cannot
  // reuse a reading-only validator, even when no new measurements arrive.
  return sendPrivateJson(res, body, { user: req.user, body });
}
module.exports = { getDistrictSummary, summaryClock };
