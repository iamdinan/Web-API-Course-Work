const { parseRecordedAt } = require("../../utils/timestamps");
const { sendError } = require("../../utils/http-errors");
const { publicUuid } = require("../../services/user-principal");

function readingQuery(geography = []) {
  return function validate(req, res, next) {
    const query = req.query;
    const allowed = ["offset", "limit", "from", "to", "sort", ...geography];
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 50);
    const sort = query.sort ?? "-timestamp";
    const from = query.from === undefined ? null : parseRecordedAt(query.from);
    const to = query.to === undefined ? null : parseRecordedAt(query.to);
    const invalid = Object.keys(query).some(key => !allowed.includes(key) || typeof query[key] !== "string") ||
      geography.some(key => query[key] !== undefined && !publicUuid.test(query[key])) ||
      ["offset", "limit"].some(key => query[key] !== undefined && !/^\d+$/.test(query[key])) ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isSafeInteger(offset + limit) || !["timestamp", "-timestamp"].includes(sort) ||
      (query.from !== undefined && !from) || (query.to !== undefined && !to) || (from && to && from >= to);
    if (invalid) {
      return sendError(res, 400, { code: "INVALID_QUERY", message: "Provide valid offset, limit (1-200), ISO from/to with from < to, and sort (timestamp or -timestamp).", details: [] });
    }
    req.readingQuery = { offset, limit, sort };
    for (const key of ["from", "to", ...geography]) if (query[key] !== undefined) req.readingQuery[key] = query[key];
    next();
  };
}

const validateReadingQuery = readingQuery();
const validateRegionalReadingQuery = readingQuery(["provinceId", "districtId", "substationId"]);
function installationQuery(geography) {
  return function validate(req, res, next) {
    const query = req.query;
    const allowed = ["offset", "limit", ...geography];
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 50);
    const invalid = Object.entries(query).some(([key, value]) => !allowed.includes(key) || typeof value !== "string") ||
      geography.some(key => query[key] !== undefined && !publicUuid.test(query[key])) ||
      ["offset", "limit"].some(key => query[key] !== undefined && !/^\d+$/.test(query[key])) ||
      !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
      !Number.isSafeInteger(offset + limit);
    if (invalid) return sendError(res, 400, { code: "INVALID_QUERY",
      message: geography.length ? "Provide valid geographic UUID filters, offset, and limit (1-200)." :
        "Provide only valid offset and limit (1-200).", details: [] });
    req.installationQuery = { offset, limit };
    for (const key of geography) if (query[key] !== undefined) req.installationQuery[key] = query[key];
    next();
  };
}
const validateInstallationQuery = installationQuery(["provinceId", "districtId", "substationId"]);
function validateSubstationInstallationQuery(req, res, next) {
  if (Object.keys(req.query).length) {
    return sendError(res, 400, { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
  }
  next();
}

module.exports = { validateReadingQuery, validateRegionalReadingQuery, validateInstallationQuery, validateSubstationInstallationQuery };
