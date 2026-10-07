const express = require("express");
const { validateUserTokenRequest } = require("../middleware/user-token-request");
const { createUserToken } = require("../controllers/user-tokens.controller");

const router = express.Router();
router.post("/", validateUserTokenRequest, createUserToken);

module.exports = router;
