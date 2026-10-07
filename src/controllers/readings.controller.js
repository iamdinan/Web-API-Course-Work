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

module.exports = { postReading };
