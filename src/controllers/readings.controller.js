const readings = require("../services/readings.service");
const { apiBaseUrl } = require("../config/env");
const { createHash } = require("node:crypto");
const { sendError } = require("../utils/http-errors");

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

async function getReadings(req, res) {
  let body;
  try {
    body = await readings.listReadings(req.user, req.params.installationId, req.readingQuery);
  } catch (error) {
    if (!(error instanceof readings.ReadingAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Installation not found.", details: [] });
  const tag = createHash("sha256").update(JSON.stringify({
    user: req.user, installationId: req.params.installationId, query: req.readingQuery, body,
  })).digest("hex");
  // No reliable collection revision exists for an entire paginated envelope.
  // Express evaluates If-None-Match after all access, query and persistence checks.
  return res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

module.exports = { postReading, getReading, getReadings };
