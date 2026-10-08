const { Province, District, GridSubstation } = require("../../models");
const { listBody } = require("../../utils/list-response");
const { publicUuid } = require("../../services/user-principal");
const mongoose = require("mongoose");
const { provinceAllows } = require("../../services/province-access");

class ProvinceAccessError extends Error {
  constructor() { super("The province is outside your permitted jurisdiction."); }
}

async function findProvince(user, provinceId) {
  return mongoose.connection.transaction(async session => {
    const province = await Province.findOne({ publicId: provinceId }).select("publicId name -_id").session(session);
    if (!province) return null;
    if (!(await provinceAllows(user, provinceId, session))) throw new ProvinceAccessError();
    const value = province.toJSON();
    return { id: value.id, name: value.name };
  }, { readConcern: { level: "snapshot" } });
}

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
  return listBody(count, records.map(record => ({ id: record.publicId, name: record.name })),
    query, "/provinces", ["provinceId", "districtId", "substationId"]);
}

module.exports = { listProvinces, ProvinceFilterConflict, findProvince, ProvinceAccessError };
