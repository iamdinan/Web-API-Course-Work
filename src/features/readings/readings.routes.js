const router = require("express").Router();
const { verifyInstallationJwt } = require("../../middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../../middleware/require-installation-ownership");
const { readingRequest } = require("./reading-request");
const { deviceWriteLimit, userReadLimit } = require("../../middleware/rate-limits");
const { postReading, getReading, getReadings } = require("./readings.controller");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { validateReadingPath, validateInstallationPath } = require("./reading-path");
const { validateReadingQuery } = require("./reading-query");

router.post("/:installationId/readings", verifyInstallationJwt, requireInstallationOwnership, readingRequest, deviceWriteLimit, postReading);
router.get("/:installationId/readings", verifyUserJwt, userReadLimit, validateInstallationPath, validateReadingQuery, getReadings);
router.get("/:installationId/readings/:readingId", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validateReadingPath, getReading);
module.exports = router;
