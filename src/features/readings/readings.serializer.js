const { createHash } = require("node:crypto");

const { displayTimestamp } = require("../../utils/timestamps");

function readingBody(document) {
  const value = document.toJSON();
  // Keep POST and GET byte-identical regardless of persisted field order, and
  // allow only the public reading fields into the representation/validator.
  return {
    installationId: value.installationId, recordedAt: value.recordedAt,
    powerKw: value.powerKw, energyKwh: value.energyKwh, voltageV: value.voltageV,
    receivedAt: value.receivedAt, id: value.id,
    recordedAtDisplay: displayTimestamp(value.recordedAt),
    receivedAtDisplay: displayTimestamp(value.receivedAt),
  };
}

function installationBody(document) {
  const value = document.toJSON();
  return { id: value.id, substationId: value.substationId, meterId: value.meterId, status: value.status };
}

function installationETag(body) {
  // Canonical public fields only; future admin preconditions must reuse this tag.
  const canonical = { id: body.id, substationId: body.substationId, meterId: body.meterId, status: body.status };
  return `"${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}"`;
}

function overviewBody(ancestry, latestReading) {
  const province = ancestry.province.toJSON();
  const district = ancestry.district.toJSON();
  const substation = ancestry.substation.toJSON();
  // Explicit public fields keep private metadata out and serialization stable.
  return {
    installation: installationBody(ancestry.installation),
    geography: {
      province: { id: province.id, name: province.name },
      district: { id: district.id, provinceId: district.provinceId, name: district.name },
      gridSubstation: { id: substation.id, districtId: substation.districtId, name: substation.name },
    },
    latestReading,
  };
}

module.exports = { readingBody, installationBody, installationETag, overviewBody };
