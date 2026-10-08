const path = require('node:path');
const router = require('express').Router();
const { apiBaseUrl } = require('../../config/env');
const { rejectQueryParameters } = require('../../utils/public-request');
const { documentationLimit } = require('../../middleware/rate-limits');
const assetDirectory = require('swagger-ui-dist').getAbsoluteFSPath();

// Explicit assets avoid exposing the distribution's sample spec/configuration.
const assets = {
  'swagger-ui.css': 'text/css',
  'swagger-ui-bundle.js': 'application/javascript',
};
router.use(rejectQueryParameters);
router.get('/', documentationLimit, (req, res) => {
  if (!req.accepts('html')) return res.status(406).end();
  res.set('Cache-Control', 'no-cache').type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solar Generation API documentation</title>
<link rel="icon" href="data:,"><link rel="stylesheet" href="${apiBaseUrl}/docs/swagger-ui.css"></head>
<body><div id="swagger-ui"></div>
<script src="${apiBaseUrl}/docs/swagger-ui-bundle.js"></script>
<script>
// Reading flows first; creation, status changes and deletion follow.
const operationOrder = [
  'post /auth/user-tokens',
  'post /auth/device-tokens',
  'get /provinces',
  'get /provinces/{provinceId}',
  'get /provinces/{provinceId}/districts',
  'get /districts/{districtId}',
  'get /districts/{districtId}/grid-substations',
  'get /grid-substations/{substationId}',
  'get /installations',
  'get /grid-substations/{substationId}/installations',
  'get /installations/{installationId}',
  'get /installations/{installationId}/overview',
  'post /installations',
  'patch /installations/{installationId}',
  'delete /installations/{installationId}',
  'get /readings',
  'get /installations/{installationId}/readings',
  'get /installations/{installationId}/readings/{readingId}',
  'get /installations/{installationId}/last-reading',
  'post /installations/{installationId}/readings',
  'get /districts/{districtId}/generation-summary',
  'get /health',
  'get /openapi.json'
];
const operationRank = operation => {
  const rank = operationOrder.indexOf(operation.get('method') + ' ' + operation.get('path'));
  return rank < 0 ? operationOrder.length : rank;
};
window.ui = SwaggerUIBundle({
  url: ${JSON.stringify(`${apiBaseUrl}/openapi.json`)},
  dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis],
  operationsSorter: (a, b) => operationRank(a) - operationRank(b),
  queryConfigEnabled: false,
  validatorUrl: null
});
</script></body></html>`);
});
for (const [file, contentType] of Object.entries(assets)) {
  router.get(`/${file}`, documentationLimit, (req, res, next) => {
    if (!req.accepts(contentType)) return res.status(406).end();
    res.type(contentType).sendFile(path.join(assetDirectory, file), {
      cacheControl: false,
      headers: { 'Cache-Control': 'no-cache' },
    }, error => { if (error) next(error); });
  });
}

module.exports = router;
