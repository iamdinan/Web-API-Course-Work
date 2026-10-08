const router = require("express").Router();
const { verifyInstallationJwt } = require("../../middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../../middleware/require-installation-ownership");
const { readingRequest } = require("./reading-request");
const { deviceWriteLimit, userReadLimit } = require("../../middleware/rate-limits");
const { postReading, getReading, getLastReading, getReadings, getOverview } = require("./readings.controller");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { validateReadingPath, validateInstallationPath } = require("./reading-path");
const { validateReadingQuery, validateRegionalReadingQuery } = require("./reading-query");

router.get("/readings", verifyUserJwt, userReadLimit, validateRegionalReadingQuery, getReadings);
router.get("/installations/:installationId/last-reading", verifyUserJwt, userReadLimit, validateInstallationPath, getLastReading);
router.get("/installations/:installationId/overview", verifyUserJwt, userReadLimit, validateInstallationPath, getOverview);
router.post("/installations/:installationId/readings", verifyInstallationJwt, requireInstallationOwnership, readingRequest, deviceWriteLimit, postReading);
router.get("/installations/:installationId/readings", verifyUserJwt, userReadLimit, validateInstallationPath, validateReadingQuery, getReadings);
router.get("/installations/:installationId/readings/:readingId", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validateReadingPath, getReading);
module.exports = router;
