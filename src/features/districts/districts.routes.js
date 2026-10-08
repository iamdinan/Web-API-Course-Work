const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");
const { getDistrict, getProvinceDistricts } = require("./districts.controller");

function validatePublicRequest(parameter) {
  return (req, res, next) => {
    if (!publicUuid.test(req.params[parameter])) {
      return sendError(res, 400, { code: "INVALID_REQUEST", message: `${parameter} must be a public UUID.`, details: [] });
    }
    if (Object.keys(req.query).length) {
      return sendError(res, 400, { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
    }
    next();
  };
}

router.get("/districts/:districtId", verifyUserJwt, userReadLimit, validatePublicRequest("districtId"), getDistrict);
router.get("/provinces/:provinceId/districts", verifyUserJwt, userReadLimit, validatePublicRequest("provinceId"), getProvinceDistricts);
module.exports = router;
