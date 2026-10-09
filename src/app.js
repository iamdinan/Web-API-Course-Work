const express = require('express');
const { apiBaseUrl } = require('./config/env');
const apiRouter = require('./routes/api.routes');
const { notFound, errorHandler } = require('./middleware/error-handler');

const protectedReadPaths = [
  /^\/installations(?:\/[^/]+(?:\/(readings(?:\/[^/]+)?|latest-reading|overview))?)?\/?$/i,
  /^\/readings\/?$/i,
  /^\/grid-substations\/[^/]+(?:\/installations)?\/?$/i,
  /^\/districts\/[^/]+(?:\/(grid-substations|generation-summary))?\/?$/i,
  /^\/provinces(?:\/[^/]+(?:\/districts)?)?\/?$/i,
];

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
// HTML and UI assets negotiate their own media types outside the JSON API gate.
app.use(`${apiBaseUrl}/docs`, require('./features/documentation/documentation.routes'));
app.use(apiBaseUrl, (req, res, next) => {
  if (/^\/health\/?$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store');
    res.locals.omitErrorValidators = true;
  }
  if (req.method === 'POST' && /^\/auth\/(user|device)-tokens\/?$/i.test(req.path)) {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  }
  if (req.method === 'POST' && /^\/installations\/[^/]+\/readings\/?$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store');
  }
  if ((req.method === 'POST' && /^\/installations\/?$/i.test(req.path)) ||
      (['PATCH', 'DELETE'].includes(req.method) && /^\/installations\/[^/]+\/?$/i.test(req.path))) {
    res.set('Cache-Control', 'no-store');
    res.locals.omitErrorValidators = true;
  }
  if (req.method === 'GET' && protectedReadPaths.some(pattern => pattern.test(req.path))) {
    // Include negotiation/parser failures that happen before the protected route.
    res.set('Cache-Control', 'no-store');
    res.locals.omitErrorValidators = true;
  }
  if (!req.accepts('json')) return res.status(406).end();
  next();
}, express.json(), apiRouter);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
