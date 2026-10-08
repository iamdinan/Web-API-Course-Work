const { publicUuid } = require("../../services/user-principal");

function validateProvinceQuery(req, res, next) {
  const query = req.query;
  const allowed = ["provinceId", "districtId", "substationId", "offset", "limit"];
  const invalid = Object.entries(query).some(([key, value]) => !allowed.includes(key) || typeof value !== "string") ||
    ["provinceId", "districtId", "substationId"].some(key => query[key] !== undefined && !publicUuid.test(query[key])) ||
    ["offset", "limit"].some(key => query[key] !== undefined && (!/^\d+$/.test(query[key]) || !Number.isSafeInteger(Number(query[key]))));
  const offset = Number(query.offset ?? 0);
  const limit = Number(query.limit ?? 50);
  if (invalid || limit < 1 || limit > 200) {
    return res.status(400).json({ code: "INVALID_QUERY", message: "Provide valid geographic UUID filters, offset, and limit (1-200).", details: [] });
  }
  req.provinceQuery = { offset, limit };
  for (const key of ["provinceId", "districtId", "substationId"]) if (query[key]) req.provinceQuery[key] = query[key];
  next();
}

module.exports = { validateProvinceQuery };
