const router = require("express").Router();
const { verifyUserJwt } = require("../../middleware/verify-user-jwt");
const { userReadLimit } = require("../../middleware/rate-limits");
const { publicUuid } = require("../../services/user-principal");
const { sendError } = require("../../utils/http-errors");
const { getDistrictSummary } = require("./district-summary.controller");

router.get("/summarize-district-generation", verifyUserJwt, userReadLimit, (req, res, next) => {
  if (typeof req.query.districtId !== "string" || !publicUuid.test(req.query.districtId) ||
      Object.keys(req.query).some(key => key !== "districtId")) {
    return sendError(res, 400, { code: "INVALID_QUERY", message: "Provide exactly one districtId public UUID and no other query parameters.", details: [] });
  }
  next();
}, getDistrictSummary);
module.exports = router;
