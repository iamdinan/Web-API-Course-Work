const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { requireAdmin } = require("../../middleware/require-admin");
const { adminWriteLimit } = require("../../middleware/rate-limits");
const { validateInstallationRequest, validateStatusRequest, validateDeletionRequest } = require("./installation-request");
const { validatePublicPath } = require("../../utils/public-request");
const validateInstallationPath = validatePublicPath("installationId");
const { postInstallation, patchInstallation, deleteInstallation } = require("./installations.controller");

router.post("/installations", verifyUserJwt, requireAdmin, validateInstallationRequest, adminWriteLimit, postInstallation);
router.patch("/installations/:installationId", verifyUserJwt, requireAdmin, validateInstallationPath, validateStatusRequest, adminWriteLimit, patchInstallation);
router.delete("/installations/:installationId", verifyUserJwt, requireAdmin, validateInstallationPath, validateDeletionRequest, adminWriteLimit, deleteInstallation);
module.exports = router;
