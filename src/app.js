const express = require('express');
const { apiBaseUrl } = require('./config/env');
const apiRouter = require('./routes/api.routes');
const { notFound, errorHandler } = require('./middleware/error-handler');

const app = express();
app.disable('x-powered-by');
app.set('etag', 'strong');
app.use(apiBaseUrl, (req, res, next) => {
  if (!req.accepts('json')) return res.status(406).end();
  next();
}, express.json(), apiRouter);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
