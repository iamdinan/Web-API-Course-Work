const router = require("express").Router();
const { verifyInstallationJwt } = require("../middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../middleware/require-installation-ownership");
const { readingRequest } = require("../middleware/reading-request");
const { deviceWriteLimit } = require("../middleware/device-write-limit");
const { postReading, getReading } = require("../controllers/readings.controller");
const { verifyUserJwt } = require("../middleware/verify-user-jwt");
const { userReadLimit } = require("../middleware/user-read-limit");
const { validateReadingPath } = require("../middleware/reading-path");

router.post("/:installationId/readings", verifyInstallationJwt, requireInstallationOwnership, readingRequest, deviceWriteLimit, postReading);
router.get("/:installationId/readings/:readingId", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validateReadingPath, getReading);
module.exports = router;
