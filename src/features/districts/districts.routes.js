const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { validatePublicPath, rejectQueryParameters } = require("../../utils/public-request");
const { getDistrict, getProvinceDistricts } = require("./districts.controller");

router.get("/districts/:districtId", verifyUserJwt, userReadLimit, validatePublicPath("districtId"), rejectQueryParameters, getDistrict);
router.get("/provinces/:provinceId/districts", verifyUserJwt, userReadLimit, validatePublicPath("provinceId"), rejectQueryParameters, getProvinceDistricts);
module.exports = router;
