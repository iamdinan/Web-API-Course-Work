const { randomUUID } = require("node:crypto");

function createSeedData() {
  const province = { publicId: randomUUID(), name: "Western" };
  const district = { publicId: randomUUID(), provinceId: province.publicId, name: "Colombo" };
  const substation = { publicId: randomUUID(), districtId: district.publicId, name: "Colombo Demo Grid Substation" };
  const installations = [1, 2].map(number => ({
    publicId: randomUUID(),
    substationId: substation.publicId,
    meterId: `SEED-METER-00${number}`,
    status: "active",
  }));
  const readings = installations.flatMap((installation, index) => [0, 1, 2].map(sample => ({
    publicId: randomUUID(),
    installationId: installation.publicId,
    recordedAt: new Date(`2026-10-07T08:${30 + sample * 10}:00+05:30`),
    receivedAt: new Date(`2026-10-07T08:${30 + sample * 10}:05+05:30`),
    powerKw: 2 + index + sample * 0.25,
    energyKwh: 100 + index * 100 + sample * 0.5,
    voltageV: 230 + sample,
  })));

  return { province, district, substation, installations, readings };
}

module.exports = { ...createSeedData(), createSeedData };
