const readings = require("./readings.service");
const { apiBaseUrl } = require("../../config/env");
const { createHash } = require("node:crypto");
const { sendError } = require("../../utils/http-errors");
const { installationETag } = require("./readings.serializer");

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
  return sendReading(req, res, readings.findReading);
}

async function getLastReading(req, res) {
  return sendReading(req, res, readings.findLastReading);
}

async function sendReading(req, res, find) {
  let body;
  try {
    body = await find(req.user, req.params.installationId, req.params.readingId);
  } catch (error) {
    if (!(error instanceof readings.ReadingAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) {
    return sendError(res, 404, { code: "NOT_FOUND", message: "Reading not found.", details: [] });
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
    body = req.params.installationId
      ? await readings.listReadings(req.user, req.params.installationId, req.readingQuery)
      : await readings.listRegionalReadings(req.user, req.readingQuery);
  } catch (error) {
    if (error instanceof readings.ReadingFilterError) {
      return sendError(res, error.status, { code: error.code, message: error.message, details: [] });
    }
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

async function getOverview(req, res) {
  let body;
  try {
    body = await readings.findOverview(req.user, req.params.installationId);
  } catch (error) {
    if (!(error instanceof readings.ReadingAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Installation not found.", details: [] });
  const tag = createHash("sha256").update(JSON.stringify({ user: req.user, body })).digest("hex");
  // No timestamp reliably covers installation, geography and latest reading.
  return res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

async function getInstallation(req, res) {
  let body;
  try {
    body = await readings.findInstallation(req.user, req.params.installationId);
  } catch (error) {
    if (!(error instanceof readings.ReadingAccessError)) throw error;
    return sendError(res, 403, { code: "FORBIDDEN", message: error.message, details: [] });
  }
  if (!body) return sendError(res, 404, { code: "NOT_FOUND", message: "Installation not found.", details: [] });
  // Authorization precedes validators; no reliable metadata Last-Modified exists.
  return res.set({ "Cache-Control": "private, no-cache", ETag: installationETag(body) }).json(body);
}

async function getInstallations(req, res) {
  let body;
  try {
    body = await readings.listInstallations(req.user, req.installationQuery, req.params.substationId);
  } catch (error) {
    if (!(error instanceof readings.ReadingFilterError)) throw error;
    return sendError(res, error.status, { code: error.code, message: error.message, details: [] });
  }
  const tag = createHash("sha256").update(JSON.stringify({ user: req.user, substationId: req.params.substationId, query: req.installationQuery, body })).digest("hex");
  return res.set({ "Cache-Control": "private, no-cache", ETag: `"${tag}"` }).json(body);
}

module.exports = { postReading, getReading, getLastReading, getReadings, getOverview, getInstallation, getInstallations };
