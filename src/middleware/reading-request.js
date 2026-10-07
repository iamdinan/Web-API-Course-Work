// Explicit timezone and millisecond precision match BSON Date storage. Reject
// calendar overflow rather than allowing Date.parse to normalize invalid dates.
function parseRecordedAt(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+month - 1];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 ||
      (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function readingRequest(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must use application/json.", details: [] });
  }
  const body = req.body;
  const fields = ["recordedAt", "powerKw", "energyKwh", "voltageV"];
  const recordedAt = parseRecordedAt(body?.recordedAt);
  if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length !== fields.length ||
      !fields.every(field => Object.hasOwn(body, field)) || !recordedAt ||
      !fields.slice(1).every(field => typeof body[field] === "number" && Number.isFinite(body[field]) && body[field] >= 0)) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "Provide only recordedAt and finite nonnegative powerKw, energyKwh and voltageV.", details: [] });
  }
  req.readingInput = { recordedAt, powerKw: body.powerKw, energyKwh: body.energyKwh, voltageV: body.voltageV };
  next();
}

module.exports = { readingRequest, parseRecordedAt };
