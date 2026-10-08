const express = require("express");
const { validateUserTokenRequest } = require("./token-request");
const { createUserToken } = require("./user-tokens.controller");
const { rejectQueryParameters } = require("../../utils/public-request");

const router = express.Router();
router.post("/", validateUserTokenRequest, rejectQueryParameters, createUserToken);

module.exports = router;
