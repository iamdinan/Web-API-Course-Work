const { parseRecordedAt } = require("./reading-request");
const { sendError } = require("../utils/http-errors");

function validateReadingQuery(req, res, next) {
  const query = req.query;
  const allowed = ["offset", "limit", "from", "to", "sort"];
  const offset = Number(query.offset ?? 0);
  const limit = Number(query.limit ?? 50);
  const sort = query.sort ?? "-timestamp";
  const from = query.from === undefined ? null : parseRecordedAt(query.from);
  const to = query.to === undefined ? null : parseRecordedAt(query.to);
  const invalid = Object.keys(query).some(key => !allowed.includes(key) || typeof query[key] !== "string") ||
    ["offset", "limit"].some(key => query[key] !== undefined && !/^\d+$/.test(query[key])) ||
    !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
    !Number.isSafeInteger(offset + limit) || !["timestamp", "-timestamp"].includes(sort) ||
    (query.from !== undefined && !from) || (query.to !== undefined && !to) || (from && to && from >= to);
  if (invalid) {
    return sendError(res, 400, { code: "INVALID_QUERY", message: "Provide valid offset, limit (1-200), ISO from/to with from < to, and sort (timestamp or -timestamp).", details: [] });
  }
  req.readingQuery = { offset, limit, sort };
  for (const key of ["from", "to"]) if (query[key] !== undefined) req.readingQuery[key] = query[key];
  next();
}

module.exports = { validateReadingQuery };
