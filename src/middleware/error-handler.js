const { sendError } = require('../utils/http-errors');

function notFound(req, res) {
  res.status(404).json({ code: 'NOT_FOUND', message: 'Route not found.', details: [] });
}

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const invalidJson = error.type === 'entity.parse.failed';
  const tooLarge = error.type === 'entity.too.large';
  sendError(res, invalidJson ? 400 : tooLarge ? 413 : 500, {
    code: invalidJson ? 'INVALID_JSON' : tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_SERVER_ERROR',
    message: invalidJson ? 'Request body must be valid JSON.' : tooLarge ? 'Request body is too large.' : 'An unexpected error occurred.',
    details: [],
  });
}

module.exports = { notFound, errorHandler };
