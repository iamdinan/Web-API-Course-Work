const express = require("express");
const { validateDeviceTokenRequest } = require("../middleware/device-token-request");
const { createDeviceToken } = require("../controllers/device-tokens.controller");

const router = express.Router();
router.post("/", validateDeviceTokenRequest, createDeviceToken);

module.exports = router;
