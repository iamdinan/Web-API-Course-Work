const { District, Province } = require("../models");
const { publicUuid } = require("./user-principal");

async function districtAncestry(districtId, session) {
  const district = await District.findOne({ publicId: districtId })
    .select("publicId provinceId name -_id").session(session);
  if (!district || !publicUuid.test(district.provinceId)) return null;
  const province = await Province.findOne({ publicId: district.provinceId })
    .select("publicId -_id").session(session).lean();
  return province ? district : null;
}

module.exports = { districtAncestry };
