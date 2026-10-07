const { Province, District, GridSubstation } = require("../models");
const { apiBaseUrl } = require("../config/env");
const { publicUuid } = require("./user-principal");

class ProvinceFilterConflict extends Error {}

async function provinceFilter(user, query) {
  let provinceId;
  let districtScope = {};
  if (user.readScope === "province") {
    provinceId = user.provinceId;
    districtScope = { provinceId };
  } else if (user.readScope === "district") {
    const district = await District.findOne({ publicId: user.districtId }).select("publicId provinceId").lean();
    if (!district || typeof district.provinceId !== "string" || !publicUuid.test(district.provinceId)) return null;
    provinceId = district.provinceId;
    districtScope = { publicId: user.districtId };
  }
  if (query.provinceId) {
    if (provinceId && query.provinceId !== provinceId) return null;
    provinceId = query.provinceId;
    const province = await Province.findOne({ publicId: provinceId }).select("publicId").lean();
    if (!province) return null;
  }
  if (query.districtId) {
    if (districtScope.publicId && query.districtId !== districtScope.publicId) return null;
    const district = await District.findOne({ ...districtScope, publicId: query.districtId }).select("publicId provinceId").lean();
    if (!district || typeof district.provinceId !== "string" || !publicUuid.test(district.provinceId)) return null;
    if (provinceId && district.provinceId !== provinceId) throw new ProvinceFilterConflict();
    provinceId = district.provinceId;
  }
  if (query.substationId) {
    const districts = await District.find(districtScope).select("publicId provinceId").lean();
    const substation = await GridSubstation.findOne({
      publicId: query.substationId, districtId: { $in: districts.map(district => district.publicId) },
    }).select("districtId").lean();
    if (!substation) return null;
    const parent = districts.find(district => district.publicId === substation.districtId);
    if (!parent || typeof parent.provinceId !== "string" || !publicUuid.test(parent.provinceId)) return null;
    const substationProvinceId = parent.provinceId;
    if ((query.districtId && substation.districtId !== query.districtId) ||
        (provinceId && substationProvinceId !== provinceId)) throw new ProvinceFilterConflict();
    provinceId = substationProvinceId;
  }
  return provinceId ? { publicId: provinceId } : {};
}

async function listProvinces(user, query) {
  const filter = await provinceFilter(user, query);
  const count = filter === null ? 0 : await Province.countDocuments(filter);
  const records = filter === null ? [] : await Province.find(filter).select("publicId name")
    .sort({ name: 1, publicId: 1 }).skip(query.offset).limit(query.limit).lean();
  function link(offset) {
    const params = new URLSearchParams();
    for (const key of ["provinceId", "districtId", "substationId"]) if (query[key]) params.set(key, query[key]);
    params.set("offset", String(offset));
    params.set("limit", String(query.limit));
    return `${apiBaseUrl}/provinces?${params}`;
  }
  return {
    count,
    next: query.offset + query.limit < count ? link(query.offset + query.limit) : null,
    previous: query.offset > 0 && count > 0 ? link(Math.max(0, query.offset - query.limit)) : null,
    items: records.map(record => ({ id: record.publicId, name: record.name })),
  };
}

module.exports = { listProvinces, ProvinceFilterConflict };
