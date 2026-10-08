const { publicUuid } = require("../services/user-principal");
const { sendError } = require("./http-errors");

function validatePublicPath(...parameters) {
  return (req, res, next) => {
    if (!parameters.every(parameter => typeof req.params[parameter] === "string" && publicUuid.test(req.params[parameter]))) {
      const names = parameters.join(" and ");
      const message = parameters.length === 1 ? `${names} must be a public UUID.` : `${names} must be public UUIDs.`;
      return sendError(res, 400, { code: "INVALID_REQUEST", message, details: [] });
    }
    next();
  };
}

function rejectQueryParameters(req, res, next) {
  if (Object.keys(req.query).length) {
    res.locals.omitErrorValidators = true;
    return sendError(res, 400, { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
  }
  next();
}

module.exports = { validatePublicPath, rejectQueryParameters };
