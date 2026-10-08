const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { SolarInstallation, GenerationReading, GridSubstation, District, Province } = require("../../models");
const { publicUuid, jurisdictionAllows } = require("../../services/user-principal");
const { listBody } = require("../../utils/list-response");
const readingFields = "publicId installationId recordedAt powerKw energyKwh voltageV receivedAt -_id";
const { readingBody, installationBody, overviewBody } = require("./readings.serializer");
const { regionalInstallationIds, regionalSubstationIds, ReadingFilterError } = require("./reading-geography");

async function authorizedInstallation(user, installationId, session = null) {
  const installation = await SolarInstallation.findOne({ publicId: installationId }).select("publicId substationId meterId status -_id").session(session);
  if (!installation || !publicUuid.test(installation.substationId)) return false;
  const substation = await GridSubstation.findOne({ publicId: installation.substationId }).select("publicId districtId name -_id").session(session);
  if (!substation || !publicUuid.test(substation.districtId)) return false;
  const district = await District.findOne({ publicId: substation.districtId }).select("publicId provinceId name -_id").session(session);
  if (!district || !publicUuid.test(district.provinceId)) return false;
  const province = await Province.findOne({ publicId: district.provinceId }).select("publicId name -_id").session(session);
  if (!province) return false;
  if (!jurisdictionAllows(user, district.provinceId, substation.districtId)) {
    throw new ReadingAccessError();
  }
  return { installation, substation, district, province };
}

async function findReading(user, installationId, readingId) {
  if (!await authorizedInstallation(user, installationId)) return null;
  // Scope is established before loading the reading. Bind BOTH URL identities.
  const reading = await GenerationReading.findOne({ publicId: readingId, installationId })
    .select(readingFields);
  return reading ? readingBody(reading) : null;
}

async function findLastReading(user, installationId) {
  if (!await authorizedInstallation(user, installationId)) return null;
  return latestReadingBody(installationId);
}

async function latestReadingBody(installationId, session = null) {
  const reading = await GenerationReading.findOne({ installationId })
    .select(readingFields).session(session).sort({ recordedAt: -1, publicId: -1 });
  return reading ? readingBody(reading) : null;
}

async function findOverview(user, installationId) {
  return mongoose.connection.transaction(async session => {
    const ancestry = await authorizedInstallation(user, installationId, session);
    if (!ancestry) return null;
    const latestReading = await latestReadingBody(installationId, session);
    return overviewBody(ancestry, latestReading);
  }, { readConcern: { level: "snapshot" } });
}

async function findInstallation(user, installationId) {
  return mongoose.connection.transaction(async session => {
    const ancestry = await authorizedInstallation(user, installationId, session);
    return ancestry ? installationBody(ancestry.installation) : null;
  }, { readConcern: { level: "snapshot" } });
}

async function listInstallations(user, query, substationId) {
  return mongoose.connection.transaction(async session => {
    // Both routes resolve and authorize geography before any count/page query.
    const substationIds = await regionalSubstationIds(user, substationId ? { ...query, substationId } : query, session);
    const filter = { substationId: { $in: substationIds } };
    const count = await SolarInstallation.countDocuments(filter).session(session);
    const recordsQuery = SolarInstallation.find(filter)
      .select("publicId substationId meterId status -_id").session(session).sort({ publicId: 1 });
    if (query) recordsQuery.skip(query.offset).limit(query.limit);
    const records = await recordsQuery;
    return listBody(count, records.map(installationBody), query,
      substationId ? `/grid-substations/${substationId}/installations` : "/installations",
      substationId ? [] : ["provinceId", "districtId", "substationId"]);
  }, { readConcern: { level: "snapshot" } });
}

async function listReadings(user, installationId, query) {
  // A single read snapshot keeps the authorized ancestry, count and page coherent
  // when an ingestion commits between the count and page queries.
  return mongoose.connection.transaction(async session => {
    if (!await authorizedInstallation(user, installationId, session)) return null;
    return readingPage({ installationId }, query, `/installations/${installationId}/readings`, session);
  }, { readConcern: { level: "snapshot" } });
}

async function listRegionalReadings(user, query) {
  return mongoose.connection.transaction(async session => {
    const installationIds = await regionalInstallationIds(user, query, session);
    return readingPage({ installationId: { $in: installationIds } }, query, "/readings", session);
  }, { readConcern: { level: "snapshot" } });
}

async function readingPage(filter, query, resource, session) {
  if (query.from || query.to) {
    filter.recordedAt = {};
    if (query.from) filter.recordedAt.$gte = new Date(query.from);
    if (query.to) filter.recordedAt.$lt = new Date(query.to);
  }
  const count = await GenerationReading.countDocuments(filter).session(session);
  const direction = query.sort === "timestamp" ? 1 : -1;
  const records = await GenerationReading.find(filter).select(readingFields).session(session)
    .sort({ recordedAt: direction, publicId: direction }).skip(query.offset).limit(query.limit);
  return listBody(count, records.map(readingBody), query, resource,
    ["provinceId", "districtId", "substationId", "from", "to", "sort"]);
}

class ReadingAccessError extends Error {
  constructor() {
    super("The installation is outside your permitted jurisdiction.");
  }
}

class ReadingWriteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function createReading(installationId, input) {
  // Initialize indexes before opening the transaction, including timestamp uniqueness.
  await GenerationReading.init();
  try {
    return await mongoose.connection.transaction(async session => {
      // A real write (not a snapshot-only check or no-op update) conflicts with
      // lifecycle writes on this same document. Transaction retries recheck status.
      const parent = await SolarInstallation.updateOne(
        { publicId: installationId, status: "active" },
        { $set: { _ingestionLock: randomUUID() } }, { session },
      );
      if (parent.matchedCount !== 1) {
        const current = await SolarInstallation.findOne({ publicId: installationId }).select("status").session(session).lean();
        if (current?.status === "inactive") {
          throw new ReadingWriteError(403, "INSTALLATION_INACTIVE", "Inactive installations cannot authenticate for writes.");
        }
        throw new ReadingWriteError(401, "UNAUTHORIZED", "A valid installation bearer token is required.");
      }
      const reading = new GenerationReading({ ...input, installationId, receivedAt: new Date() });
      await reading.save({ session });
      await SolarInstallation.updateOne({ publicId: installationId }, { $unset: { _ingestionLock: "" } }, { session });
      return readingBody(reading);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.installationId && error.keyPattern?.recordedAt) {
      throw new ReadingWriteError(409, "DUPLICATE_READING", "A reading already exists for this installation and recordedAt.");
    }
    throw error;
  }
}

module.exports = { createReading, findReading, findLastReading, findOverview, findInstallation, listInstallations, listReadings, listRegionalReadings, ReadingFilterError, ReadingWriteError, ReadingAccessError };
