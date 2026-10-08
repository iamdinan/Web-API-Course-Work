const router = require("express").Router();
const { verifyInstallationJwt } = require("../../middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../../middleware/require-installation-ownership");
const { readingRequest } = require("./reading-request");
const { deviceWriteLimit, userReadLimit } = require("../../middleware/rate-limits");
const { postReading, getReading, getLastReading, getReadings, getOverview, getInstallation, getInstallations } = require("./readings.controller");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { validatePublicPath, rejectQueryParameters } = require("../../utils/public-request");
const validateInstallationPath = validatePublicPath("installationId");
const { validateReadingQuery, validateRegionalReadingQuery, validateInstallationQuery } = require("./reading-query");

router.get("/readings", verifyUserJwt, userReadLimit, validateRegionalReadingQuery, getReadings);
router.get("/installations", verifyUserJwt, userReadLimit, validateInstallationQuery, getInstallations);
router.get("/grid-substations/:substationId/installations", verifyUserJwt, userReadLimit, validatePublicPath("substationId"), rejectQueryParameters, getInstallations);
router.get("/installations/:installationId", verifyUserJwt, userReadLimit, validateInstallationPath, rejectQueryParameters, getInstallation);
router.get("/installations/:installationId/last-reading", verifyUserJwt, userReadLimit, validateInstallationPath, rejectQueryParameters, getLastReading);
router.get("/installations/:installationId/overview", verifyUserJwt, userReadLimit, validateInstallationPath, rejectQueryParameters, getOverview);
router.post("/installations/:installationId/readings", verifyInstallationJwt, requireInstallationOwnership, readingRequest, rejectQueryParameters, deviceWriteLimit, postReading);
router.get("/installations/:installationId/readings", verifyUserJwt, userReadLimit, validateInstallationPath, validateReadingQuery, getReadings);
router.get("/installations/:installationId/readings/:readingId", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validatePublicPath("installationId", "readingId"), rejectQueryParameters, getReading);
module.exports = router;
