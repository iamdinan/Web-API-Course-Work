const express = require("express");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { validateProvinceQuery } = require("./province-query");
const { getProvinces, getProvince } = require("./provinces.controller");
const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");

const router = express.Router();
router.get("/", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validateProvinceQuery, getProvinces);

router.get("/:provinceId", verifyUserJwt, userReadLimit, (req, res, next) => {
  if (!publicUuid.test(req.params.provinceId)) {
    return sendError(res, 400, { code: "INVALID_REQUEST", message: "provinceId must be a public UUID.", details: [] });
  }
  if (Object.keys(req.query).length) {
    return sendError(res, 400, { code: "INVALID_QUERY", message: "This endpoint does not accept query parameters.", details: [] });
  }
  next();
}, getProvince);

module.exports = router;
