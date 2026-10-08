const displayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Colombo", day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h12",
});

function displayTimestamp(value) {
  const parts = Object.fromEntries(displayTime.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()} (Sri Lanka)`;
}

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

function overviewBody(ancestry, latestReading) {
  const installation = ancestry.installation.toJSON();
  const province = ancestry.province.toJSON();
  const district = ancestry.district.toJSON();
  const substation = ancestry.substation.toJSON();
  // Explicit public fields keep private metadata out and serialization stable.
  return {
    installation: { id: installation.id, substationId: installation.substationId,
      meterId: installation.meterId, status: installation.status },
    geography: {
      province: { id: province.id, name: province.name },
      district: { id: district.id, provinceId: district.provinceId, name: district.name },
      gridSubstation: { id: substation.id, districtId: substation.districtId, name: substation.name },
    },
    latestReading,
  };
}

module.exports = { readingBody, overviewBody };
