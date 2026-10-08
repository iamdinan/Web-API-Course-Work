const express = require("express");
const { validateDeviceTokenRequest } = require("./token-request");
const { createDeviceToken } = require("./device-tokens.controller");

const router = express.Router();
router.post("/", validateDeviceTokenRequest, createDeviceToken);

module.exports = router;
