const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { validatePublicPath, rejectQueryParameters } = require("../../utils/public-request");
const { getDistrictSummary } = require("./district-summary.controller");

router.get("/districts/:districtId/generation-summary", verifyUserJwt, userReadLimit,
  validatePublicPath("districtId"), rejectQueryParameters, getDistrictSummary);
module.exports = router;
