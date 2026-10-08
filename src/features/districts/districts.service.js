const mongoose = require("mongoose");
const { districtAncestry } = require("../../services/district-ancestry");
const { jurisdictionAllows } = require("../../services/user-principal");
const { Province, District } = require("../../models");
const { listBody } = require("../../utils/list-response");
const { provinceAllows } = require("../../services/province-access");

class DistrictAccessError extends Error {
  constructor(message = "The district is outside your permitted jurisdiction.") {
    super(message);
  }
}

function districtBody(document) {
  const value = document.toJSON();
  return { id: value.id, provinceId: value.provinceId, name: value.name };
}

async function findDistrict(user, districtId) {
  return mongoose.connection.transaction(async session => {
    const district = await districtAncestry(districtId, session);
    if (!district) return null;
    if (!jurisdictionAllows(user, district.provinceId, districtId)) throw new DistrictAccessError();
    return districtBody(district);
  }, { readConcern: { level: "snapshot" } });
}

async function listProvinceDistricts(user, provinceId) {
  return mongoose.connection.transaction(async session => {
    const province = await Province.findOne({ publicId: provinceId }).select("publicId -_id").session(session).lean();
    if (!province) return null;
    if (!(await provinceAllows(user, provinceId, session))) {
      throw new DistrictAccessError("The province is outside your permitted jurisdiction.");
    }
    const districtId = user.readScope === "district" ? user.districtId : undefined;
    const filter = { provinceId, ...(districtId ? { publicId: districtId } : {}) };
    const records = await District.find(filter).select("publicId provinceId name -_id")
      .session(session).sort({ name: 1, publicId: 1 });
    return listBody(records.length, records.map(districtBody));
  }, { readConcern: { level: "snapshot" } });
}

module.exports = { findDistrict, listProvinceDistricts, DistrictAccessError };
