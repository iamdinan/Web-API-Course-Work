const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { requireAdmin } = require("../../middleware/require-admin");
const { adminWriteLimit } = require("../../middleware/rate-limits");
const { validateInstallationRequest } = require("./installation-request");
const { postInstallation } = require("./installations.controller");

router.post("/installations", verifyUserJwt, requireAdmin, validateInstallationRequest, adminWriteLimit, postInstallation);
module.exports = router;
