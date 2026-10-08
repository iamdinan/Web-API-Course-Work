const readings = require("../services/readings.service");
const { apiBaseUrl } = require("../config/env");

async function postReading(req, res) {
  try {
    const body = await readings.createReading(req.installation.id, req.readingInput);
    // Express's configured strong ETag hashes the exact serialized public body.
    return res.set({
      Location: `${apiBaseUrl}/installations/${req.installation.id}/readings/${body.id}`,
      "Last-Modified": new Date(body.receivedAt).toUTCString(),
    }).status(201).json(body);
  } catch (error) {
    if (!(error instanceof readings.ReadingWriteError)) throw error;
    if (error.status === 401) res.set("WWW-Authenticate", "Bearer");
    return res.status(error.status).json({ code: error.code, message: error.message, details: [] });
  }
}

async function getReading(req, res) {
  let body;
  try {
    body = await readings.findReading(req.user, req.params.installationId, req.params.readingId);
  } catch (error) {
    if (!(error instanceof readings.ReadingAccessError)) throw error;
    return res.status(403).json({ code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) {
    return res.status(404).json({ code: "NOT_FOUND", message: "Reading not found.", details: [] });
  }
  // Express generates the same strong ETag as POST and evaluates freshness only
  // after current authentication, rate limiting, jurisdiction and identity checks.
  return res.set({
    "Cache-Control": "private, no-cache",
    "Last-Modified": new Date(body.receivedAt).toUTCString(),
  }).json(body);
}

module.exports = { postReading, getReading };
