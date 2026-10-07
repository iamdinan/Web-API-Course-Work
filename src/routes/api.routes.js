const express = require('express');
const healthRouter = require('./health.routes');
const specification = require('../../docs/openapi.json');
const { apiBaseUrl } = require('../config/env');

const router = express.Router();
router.use('/health', healthRouter);
router.use('/auth/user-tokens', require('./user-tokens.routes'));
router.use('/auth/device-tokens', require('./device-tokens.routes'));
router.use('/provinces', require('./provinces.routes'));
router.use('/installations', require('./readings.routes'));
router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'no-cache').json({
    ...specification,
    servers: [{ url: apiBaseUrl }],
  });
});

module.exports = router;
