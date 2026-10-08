const express = require("express");
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { validateProvinceQuery } = require("./province-query");
const { getProvinces } = require("./provinces.controller");

const router = express.Router();
router.get("/", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
}, verifyUserJwt, userReadLimit, validateProvinceQuery, getProvinces);

module.exports = router;
