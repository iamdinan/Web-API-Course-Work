const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");
const { getSubstation, getDistrictSubstations } = require("./grid-substations.controller");

function validateSubstationPath(req, res, next) {
  if (!publicUuid.test(req.params.substationId)) {
    return sendError(res, 400, { code: "INVALID_REQUEST", message: "substationId must be a public UUID.", details: [] });
  }
  next();
}

function validateDistrictList(req, res, next) {
  if (!publicUuid.test(req.params.districtId)) {
    return sendError(res, 400, { code: "INVALID_REQUEST", message: "districtId must be a public UUID.", details: [] });
  }
  if (Object.keys(req.query).length) {
    return sendError(res, 400, { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
  }
  next();
}

router.get("/grid-substations/:substationId", verifyUserJwt, userReadLimit, validateSubstationPath, getSubstation);
router.get("/districts/:districtId/grid-substations", verifyUserJwt, userReadLimit, validateDistrictList, getDistrictSubstations);
module.exports = router;
