const { parseRecordedAt } = require("../../utils/timestamps");

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

module.exports = { readingRequest };
