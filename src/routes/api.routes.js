const express = require('express');
const healthRouter = require('../features/health/health.routes');
const specification = require('../../docs/openapi.json');
const { apiBaseUrl } = require('../config/env');

const router = express.Router();
router.use('/health', healthRouter);
router.use('/auth/user-tokens', require('../features/auth/user-tokens.routes'));
router.use('/auth/device-tokens', require('../features/auth/device-tokens.routes'));
router.use('/provinces', require('../features/provinces/provinces.routes'));
router.use('/', require('../features/districts/districts.routes'));
router.use('/', require('../features/grid-substations/grid-substations.routes'));
router.use('/', require('../features/readings/readings.routes'));
router.use('/', require('../features/installations/installations.routes'));
router.use('/', require('../features/district-summary/district-summary.routes'));
router.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'no-cache').json({
    ...specification,
    servers: [{ url: apiBaseUrl }],
  });
});

module.exports = router;
