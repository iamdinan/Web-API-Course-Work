const { tokenRequest } = require("./token-request");

const validateUserTokenRequest = tokenRequest({
  fields: ["email", "password"],
  valid: body => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()),
  message: "Provide only a valid email and a nonempty password.",
  attach(req, body) {
    req.userCredentials = { email: body.email.trim().toLowerCase(), password: body.password };
  },
});

module.exports = { validateUserTokenRequest };
