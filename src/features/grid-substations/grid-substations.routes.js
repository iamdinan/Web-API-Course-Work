const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { validatePublicPath, rejectQueryParameters } = require("../../utils/public-request");
const { getSubstation, getDistrictSubstations } = require("./grid-substations.controller");

router.get("/grid-substations/:substationId", verifyUserJwt, userReadLimit, validatePublicPath("substationId"), getSubstation);
router.get("/districts/:districtId/grid-substations", verifyUserJwt, userReadLimit, validatePublicPath("districtId"), rejectQueryParameters, getDistrictSubstations);
module.exports = router;
