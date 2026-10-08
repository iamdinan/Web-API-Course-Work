const express = require("express");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { getProvinces, getProvince } = require("./provinces.controller");
const { validatePublicPath, rejectQueryParameters } = require("../../utils/public-request");

const router = express.Router();
router.get("/", verifyUserJwt, userReadLimit, rejectQueryParameters, getProvinces);

router.get("/:provinceId", verifyUserJwt, userReadLimit, validatePublicPath("provinceId"), rejectQueryParameters, getProvince);

module.exports = router;
