const express = require("express");
const { validateDeviceTokenRequest } = require("./token-request");
const { createDeviceToken } = require("./device-tokens.controller");
const { rejectQueryParameters } = require("../../utils/public-request");

const router = express.Router();
router.post("/", validateDeviceTokenRequest, rejectQueryParameters, createDeviceToken);

module.exports = router;
