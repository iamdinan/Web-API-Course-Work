const { Province, District, GridSubstation, SolarInstallation } = require("../../models");

class ReadingFilterError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function regionalSubstationIds(user, query, session) {
  async function ancestry(kind, id) {
    const models = { province: Province, district: District, substation: GridSubstation };
    const fields = { province: "publicId", district: "publicId provinceId", substation: "publicId districtId" };
    const resource = await models[kind].findOne({ publicId: id }).select(`${fields[kind]} -_id`).session(session).lean();
    if (!resource) throw new ReadingFilterError(404, "NOT_FOUND", "Geography resource not found.");
    if (kind === "province") return { provinceId: resource.publicId };
    if (kind === "district") return { ...await ancestry("province", resource.provinceId), districtId: resource.publicId };
    return { ...await ancestry("district", resource.districtId), substationId: resource.publicId };
  }

  // A district analyst may select their parent province, but results still stay
  // within their district. Broken implicit ancestry produces an empty scope.
  let scope = {};
  try {
    if (user.readScope === "province") scope = await ancestry("province", user.provinceId);
    if (user.readScope === "district") scope = await ancestry("district", user.districtId);
  } catch (error) {
    if (!(error instanceof ReadingFilterError)) throw error;
    // Explicit filters still resolve below, preserving their missing-resource errors.
    scope = { missing: true };
  }
  const targets = [];
  for (const kind of ["province", "district", "substation"]) {
    const key = `${kind}Id`;
    if (!query[key]) continue;
    const target = await ancestry(kind, query[key]);
    if (scope.missing || (scope.provinceId && target.provinceId !== scope.provinceId) ||
        (scope.districtId && target.districtId && target.districtId !== scope.districtId)) {
      throw new ReadingFilterError(403, "FORBIDDEN", "The geography filter is outside your permitted jurisdiction.");
    }
    targets.push(target);
  }
  const selected = {};
  for (const target of targets) {
    for (const [key, id] of Object.entries(target)) {
      if (selected[key] && selected[key] !== id) {
        throw new ReadingFilterError(400, "INVALID_QUERY", "Geography filters have contradictory ancestry.");
      }
      selected[key] = id;
    }
  }
  if (scope.missing) return [];
  const area = { ...scope, ...selected };
  const provinces = await Province.find(area.provinceId ? { publicId: area.provinceId } : {})
    .select("publicId -_id").session(session).lean();
  const districts = await District.find({ provinceId: { $in: provinces.map(value => value.publicId) },
    ...(area.districtId ? { publicId: area.districtId } : {}) }).select("publicId -_id").session(session).lean();
  const substations = await GridSubstation.find({ districtId: { $in: districts.map(value => value.publicId) },
    ...(area.substationId ? { publicId: area.substationId } : {}) }).select("publicId -_id").session(session).lean();
  return substations.map(value => value.publicId);
}

async function regionalInstallationIds(user, query, session) {
  const substationIds = await regionalSubstationIds(user, query, session);
  const installations = await SolarInstallation.find({ substationId: { $in: substationIds } })
    .select("publicId -_id").session(session).lean();
  return installations.map(value => value.publicId);
}

module.exports = { regionalInstallationIds, regionalSubstationIds, ReadingFilterError };
