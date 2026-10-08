const mongoose = require("mongoose");
const { randomUUID } = require("node:crypto");
const { SolarInstallation, GenerationReading, GridSubstation, District, Province } = require("../../models");
const { publicUuid } = require("../../services/user-principal");
const { apiBaseUrl } = require("../../config/env");
const readingFields = "publicId installationId recordedAt powerKw energyKwh voltageV receivedAt -_id";
const { readingBody } = require("./readings.serializer");

async function authorizedInstallation(user, installationId, session = null) {
  const installation = await SolarInstallation.findOne({ publicId: installationId }).select("substationId -_id").session(session).lean();
  if (!installation || !publicUuid.test(installation.substationId)) return false;
  const substation = await GridSubstation.findOne({ publicId: installation.substationId }).select("districtId -_id").session(session).lean();
  if (!substation || !publicUuid.test(substation.districtId)) return false;
  const district = await District.findOne({ publicId: substation.districtId }).select("provinceId -_id").session(session).lean();
  if (!district || !publicUuid.test(district.provinceId)) return false;
  const province = await Province.findOne({ publicId: district.provinceId }).select("publicId -_id").session(session).lean();
  if (!province) return false;
  if ((user.readScope === "province" && district.provinceId !== user.provinceId) ||
      (user.readScope === "district" && substation.districtId !== user.districtId) ||
      !["national", "province", "district"].includes(user.readScope)) {
    throw new ReadingAccessError();
  }
  return true;
}

async function findReading(user, installationId, readingId) {
  if (!await authorizedInstallation(user, installationId)) return null;
  // Scope is established before loading the reading. Bind BOTH URL identities.
  const reading = await GenerationReading.findOne({ publicId: readingId, installationId })
    .select(readingFields);
  return reading ? readingBody(reading) : null;
}

async function listReadings(user, installationId, query) {
  // A single read snapshot keeps the authorized ancestry, count and page coherent
  // when an ingestion commits between the count and page queries.
  return mongoose.connection.transaction(async session => {
    if (!await authorizedInstallation(user, installationId, session)) return null;
    const filter = { installationId };
    if (query.from || query.to) {
      filter.recordedAt = {};
      if (query.from) filter.recordedAt.$gte = new Date(query.from);
      if (query.to) filter.recordedAt.$lt = new Date(query.to);
    }
    const count = await GenerationReading.countDocuments(filter).session(session);
    const direction = query.sort === "timestamp" ? 1 : -1;
    const records = await GenerationReading.find(filter).select(readingFields).session(session)
      .sort({ recordedAt: direction, publicId: direction }).skip(query.offset).limit(query.limit);
    function link(offset) {
      const params = new URLSearchParams();
      for (const key of ["from", "to"]) if (query[key]) params.set(key, query[key]);
      params.set("sort", query.sort);
      params.set("offset", String(offset));
      params.set("limit", String(query.limit));
      return `${apiBaseUrl}/installations/${installationId}/readings?${params}`;
    }
    return {
      count,
      next: query.offset + query.limit < count ? link(query.offset + query.limit) : null,
      previous: query.offset > 0 && count > 0 ? link(Math.max(0, query.offset - query.limit)) : null,
      items: records.map(readingBody),
    };
  }, { readConcern: { level: "snapshot" } });
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

module.exports = { createReading, findReading, listReadings, ReadingWriteError, ReadingAccessError };
