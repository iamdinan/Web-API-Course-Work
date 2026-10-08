const express = require('express');
const { apiBaseUrl } = require('./config/env');
const apiRouter = require('./routes/api.routes');
const { notFound, errorHandler } = require('./middleware/error-handler');

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
app.use(apiBaseUrl, (req, res, next) => {
  if (req.method === 'POST' && /^\/auth\/(user|device)-tokens\/?$/i.test(req.path)) {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  }
  if (req.method === 'POST' && /^\/installations\/[^/]+\/readings\/?$/i.test(req.path)) {
    res.set('Cache-Control', 'no-store');
  }
  if ((req.method === 'POST' && /^\/installations\/?$/i.test(req.path)) ||
      (req.method === 'PATCH' && /^\/installations\/[^/]+\/?$/i.test(req.path))) {
    res.set('Cache-Control', 'no-store');
    res.locals.omitErrorValidators = true;
  }
  if (req.method === 'GET' && (/^\/installations(?:\/[^/]+(?:\/(readings|last-reading|overview))?)?\/?$/i.test(req.path) || /^\/readings\/?$/i.test(req.path) || /^\/summarize-district-generation\/?$/i.test(req.path) || /^\/grid-substations\/[^/]+(?:\/installations)?\/?$/i.test(req.path) || /^\/districts\/[^/]+(?:\/grid-substations)?\/?$/i.test(req.path) || /^\/provinces\/[^/]+(?:\/districts)?\/?$/i.test(req.path))) {
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
