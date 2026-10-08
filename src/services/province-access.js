const { districtAncestry } = require("./district-ancestry");
const { jurisdictionAllows } = require("./user-principal");

async function provinceAllows(user, provinceId, session) {
  let districtId;
  if (user.readScope === "district") {
    const assigned = await districtAncestry(user.districtId, session);
    if (!assigned || assigned.provinceId !== provinceId) return false;
    districtId = user.districtId;
  }
  return jurisdictionAllows(user, provinceId, districtId);
}

module.exports = { provinceAllows };
