const { Province, District } = require("../../models");
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

async function listProvinces(user) {
  return mongoose.connection.transaction(async session => {
    let provinceId = user.provinceId;
    if (user.readScope === "district") {
      const district = await District.findOne({ publicId: user.districtId })
        .select("provinceId -_id").session(session).lean();
      if (!district || !publicUuid.test(district.provinceId)) return listBody(0, []);
      provinceId = district.provinceId;
    }
    const filter = user.readScope === "national" ? {} : { publicId: provinceId };
    const records = await Province.find(filter).select("publicId name -_id")
      .session(session).sort({ name: 1, publicId: 1 }).lean();
    return listBody(records.length, records.map(record => ({ id: record.publicId, name: record.name })));
  }, { readConcern: { level: "snapshot" } });
}

module.exports = { listProvinces, findProvince, ProvinceAccessError };
