const express = require("express");
const { validateUserTokenRequest } = require("./token-request");
const { createUserToken } = require("./user-tokens.controller");

const router = express.Router();
router.post("/", validateUserTokenRequest, createUserToken);

module.exports = router;
