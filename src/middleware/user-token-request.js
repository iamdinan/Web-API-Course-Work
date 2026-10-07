function validateUserTokenRequest(req, res, next) {
  if (!req.is("application/json")) {
    return res.status(415).json({ code: "UNSUPPORTED_MEDIA_TYPE", message: "Request body must use application/json.", details: [] });
  }
  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== "object" ||
      Object.keys(body).length !== 2 || !Object.hasOwn(body, "email") || !Object.hasOwn(body, "password") ||
      typeof body.email !== "string" || typeof body.password !== "string" || !body.password.trim() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "Provide only a valid email and a nonempty password.", details: [] });
  }
  req.userCredentials = { email: body.email.trim().toLowerCase(), password: body.password };
  next();
}

module.exports = { validateUserTokenRequest };
