const router = require("express").Router();
const { verifyInstallationJwt } = require("../middleware/verify-installation-jwt");
const { requireInstallationOwnership } = require("../middleware/require-installation-ownership");
const { readingRequest } = require("../middleware/reading-request");
const { deviceWriteLimit } = require("../middleware/device-write-limit");
const { postReading } = require("../controllers/readings.controller");

router.post("/:installationId/readings", verifyInstallationJwt, requireInstallationOwnership, readingRequest, deviceWriteLimit, postReading);
module.exports = router;
