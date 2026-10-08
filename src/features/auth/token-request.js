function tokenRequest({ fields, valid, message, attach }) {
  return (req, res, next) => {
    if (!req.is("application/json")) {
      return res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must use application/json.", details: [] });
    }
    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== "object" ||
        Object.keys(body).length !== fields.length ||
        !fields.every(field => Object.hasOwn(body, field) && typeof body[field] === "string" && body[field].trim()) ||
        !valid(body)) {
      return res.status(400).json({ code: "INVALID_REQUEST", message, details: [] });
    }
    attach(req, body);
    next();
  };
}

const validateUserTokenRequest = tokenRequest({
  fields: ["email", "password"],
  valid: body => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()),
  message: "Provide only a valid email and a nonempty password.",
  attach(req, body) {
    req.userCredentials = { email: body.email.trim().toLowerCase(), password: body.password };
  },
});

const validateDeviceTokenRequest = tokenRequest({
  fields: ["meterId", "deviceSecret"],
  valid: () => true,
  message: "Provide only a nonempty meterId and deviceSecret.",
  attach(req, body) {
    req.deviceCredentials = { meterId: body.meterId, deviceSecret: body.deviceSecret };
  },
});

module.exports = { validateUserTokenRequest, validateDeviceTokenRequest };
