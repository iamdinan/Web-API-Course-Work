const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { requireAdmin } = require("../../middleware/require-admin");
const { adminWriteLimit } = require("../../middleware/rate-limits");
const { validateInstallationRequest, validateStatusRequest } = require("./installation-request");
const { validateInstallationPath } = require("../readings/reading-path");
const { postInstallation, patchInstallation } = require("./installations.controller");

router.post("/installations", verifyUserJwt, requireAdmin, validateInstallationRequest, adminWriteLimit, postInstallation);
router.patch("/installations/:installationId", verifyUserJwt, requireAdmin, validateInstallationPath, validateStatusRequest, adminWriteLimit, patchInstallation);
module.exports = router;
