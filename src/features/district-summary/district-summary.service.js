const mongoose = require("mongoose");
const { GridSubstation, SolarInstallation, GenerationReading } = require("../../models");
const { districtAncestry } = require("../../services/district-ancestry");
const { jurisdictionAllows } = require("../../services/user-principal");
const { displayTimestamp, colomboDayStart } = require("../../utils/timestamps");

class SummaryAccessError extends Error {
  constructor() { super("The district is outside your permitted jurisdiction."); }
}

// A counter decrease loses an interval. Resume from the lower observed counter;
// never assume a zero reset or estimate energy before the first daily sample.
function observedEnergy(readings, dayStart) {
  let energy = 0;
  let incomplete = readings.length < 2 || readings[0]?.recordedAt.getTime() !== dayStart.getTime();
  for (let index = 1; index < readings.length; index++) {
    const difference = readings[index].energyKwh - readings[index - 1].energyKwh;
    if (difference < 0) incomplete = true;
    else energy += difference;
  }
  return { energy, incomplete };
}

async function summarizeDistrict(user, districtId, asOf) {
  const dayStart = colomboDayStart(asOf);
  const freshFrom = asOf.getTime() - 30 * 60 * 1000;
  return mongoose.connection.transaction(async session => {
    const district = await districtAncestry(districtId, session);
    if (!district) return null;
    if (!jurisdictionAllows(user, district.provinceId, districtId)) throw new SummaryAccessError();
    const substations = await GridSubstation.find({ districtId }).select("publicId -_id").session(session).lean();
    const installations = await SolarInstallation.find({ substationId: { $in: substations.map(record => record.publicId) } })
      .select("publicId status -_id").sort({ publicId: 1 }).session(session).lean();
    const installationIds = installations.map(record => record.publicId);
    const latest = installationIds.length ? await GenerationReading.aggregate([
      { $match: { installationId: { $in: installationIds }, recordedAt: { $lte: asOf } } },
      { $sort: { installationId: 1, recordedAt: -1, publicId: -1 } },
      { $group: { _id: "$installationId", recordedAt: { $first: "$recordedAt" }, powerKw: { $first: "$powerKw" } } },
    ]).session(session) : [];
    const daily = installationIds.length ? await GenerationReading.find({
      installationId: { $in: installationIds }, recordedAt: { $gte: dayStart, $lte: asOf },
    }).select("installationId recordedAt energyKwh -_id").sort({ installationId: 1, recordedAt: 1, publicId: 1 })
      .session(session).lean() : [];
    const latestByInstallation = new Map(latest.map(record => [record._id, record]));
    const dailyByInstallation = new Map();
    for (const reading of daily) {
      if (!dailyByInstallation.has(reading.installationId)) dailyByInstallation.set(reading.installationId, []);
      dailyByInstallation.get(reading.installationId).push(reading);
    }
    const body = { districtId, asOf: displayTimestamp(asOf), freshInstallationCount: 0, staleInstallationCount: 0,
      currentPowerKw: 0, todayEnergyKwh: 0, incompleteEnergyInstallationCount: 0 };
    for (const installation of installations) {
      if (installation.status === "active") {
        const reading = latestByInstallation.get(installation.publicId);
        if (reading && reading.recordedAt.getTime() >= freshFrom) {
          body.freshInstallationCount++;
          body.currentPowerKw += reading.powerKw;
        } else body.staleInstallationCount++;
      }
      const observed = observedEnergy(dailyByInstallation.get(installation.publicId) || [], dayStart);
      body.todayEnergyKwh += observed.energy;
      if (observed.incomplete) body.incompleteEnergyInstallationCount++;
    }
    return body;
  }, { readConcern: { level: "snapshot" } });
}

module.exports = { summarizeDistrict, SummaryAccessError };
