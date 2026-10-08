const express = require("express");
const { rejectQueryParameters } = require("../../utils/public-request");
const { sendError } = require("../../utils/http-errors");
const health = require("./health.service");

const router = express.Router();
router.get("/", rejectQueryParameters, async (req, res) => {
  if (!(await health.checkDatabase())) {
    return sendError(res, 503, {
      code: "DATABASE_UNAVAILABLE",
      message: "Database is unavailable.",
      details: [],
    });
  }
  res
    .status(200)
    .type("json")
    .end(JSON.stringify({ status: "ok", database: "up" }));
});

module.exports = router;
