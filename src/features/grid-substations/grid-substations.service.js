const mongoose = require("mongoose");
const { GridSubstation } = require("../../models");
const { publicUuid, jurisdictionAllows } = require("../../services/user-principal");
const { listBody } = require("../../utils/list-response");
const { districtAncestry } = require("../../services/district-ancestry");

class SubstationAccessError extends Error {
  constructor(message = "The substation is outside your permitted jurisdiction.") {
    super(message);
  }
}

function substationBody(document) {
  const value = document.toJSON();
  return { id: value.id, districtId: value.districtId, name: value.name };
}

async function findSubstation(user, substationId) {
  return mongoose.connection.transaction(async session => {
    const substation = await GridSubstation.findOne({ publicId: substationId })
      .select("publicId districtId name -_id").session(session);
    if (!substation || !publicUuid.test(substation.districtId)) return null;
    const district = await districtAncestry(substation.districtId, session);
    if (!district) return null;
    if (!jurisdictionAllows(user, district.provinceId, substation.districtId)) throw new SubstationAccessError();
    return substationBody(substation);
  }, { readConcern: { level: "snapshot" } });
}

async function listDistrictSubstations(user, districtId) {
  return mongoose.connection.transaction(async session => {
    const district = await districtAncestry(districtId, session);
    if (!district) return null;
    if (!jurisdictionAllows(user, district.provinceId, districtId)) {
      throw new SubstationAccessError("The district is outside your permitted jurisdiction.");
    }
    const filter = { districtId };
    const records = await GridSubstation.find(filter).select("publicId districtId name -_id")
      .session(session).sort({ name: 1, publicId: 1 });
    return listBody(records.length, records.map(substationBody));
  }, { readConcern: { level: "snapshot" } });
}

module.exports = { findSubstation, listDistrictSubstations, SubstationAccessError };
