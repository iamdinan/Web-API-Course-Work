function sendError(res, status, body) {
  res.status(status);
  if (!res.locals?.omitErrorValidators) return res.json(body);
  // Opted-in protected collections must not expose even error-body validators.
  res.removeHeader("ETag");
  res.removeHeader("Last-Modified");
  return res.set("Cache-Control", "no-store").type("json").end(JSON.stringify(body));
}

module.exports = { sendError };
