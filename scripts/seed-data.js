// Synthetic sites mapped to Sri Lanka's real province/district hierarchy.
const hierarchy = [
  ["Western", ["Colombo", "Gampaha", "Kalutara"]],
  ["Central", ["Kandy", "Matale", "Nuwara Eliya"]],
  ["Southern", ["Galle", "Matara", "Hambantota"]],
  ["Northern", ["Jaffna", "Kilinochchi", "Mannar", "Vavuniya", "Mullaitivu"]],
  ["Eastern", ["Batticaloa", "Ampara", "Trincomalee"]],
  ["North Western", ["Kurunegala", "Puttalam"]],
  ["North Central", ["Anuradhapura", "Polonnaruwa"]],
  ["Uva", ["Badulla", "Moneragala"]],
  ["Sabaragamuwa", ["Ratnapura", "Kegalle"]],
];
const START = new Date("2026-09-30T00:00:00+05:30");
const INTERVAL_MS = 15 * 60 * 1000;
const SAMPLES = 7 * 24 * 4;
const EXPECTED = { provinces: 9, districts: 25, grid_substations: 25, solar_installations: 220, generation_readings: 147840 };

function createSites() {
  let districtIndex = 0;
  let siteIndex = 0;
  return hierarchy.flatMap(([provinceName, districts]) => districts.map(districtName => {
    const index = districtIndex++;
    return {
      provinceName, districtName, substationName: `${districtName} Grid Substation`,
      installations: Array.from({ length: index < 20 ? 9 : 8 }, (_, number) => ({
        meterId: `METER-${String(index + 1).padStart(2, "0")}-${String(number + 1).padStart(2, "0")}`,
        profileIndex: siteIndex++,
      })),
    };
  }));
}

function* generateReadings(installationId, profileIndex) {
  const capacityKw = 3 + (profileIndex % 13);
  let energyKwh = 1000 + profileIndex * 100;
  let previousPower = 0;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const day = Math.floor(sample / 96);
    const hour = (sample % 96) / 4;
    const sun = hour > 6 && hour < 18 ? Math.sin(Math.PI * (hour - 6) / 12) : 0;
    const weather = 0.72 + 0.2 * (0.5 + 0.5 * Math.sin(day * 1.7 + profileIndex * 0.31));
    const cloud = 0.92 + 0.08 * Math.cos(hour * 1.3 + profileIndex + day);
    const powerKw = Math.round(capacityKw * sun * weather * cloud * 1000) / 1000;
    // Instantaneous samples: trapezoidal integration over 0.25 hours.
    if (sample > 0) energyKwh += (previousPower + powerKw) * 0.125;
    const recordedAt = new Date(START.getTime() + sample * INTERVAL_MS);
    yield {
      installationId, recordedAt, receivedAt: new Date(recordedAt.getTime() + 5000),
      powerKw, energyKwh: Math.round(energyKwh * 1e6) / 1e6,
      voltageV: Math.round((230 + 2 * Math.sin(sample * 0.23 + profileIndex)) * 10) / 10,
    };
    previousPower = powerKw;
  }
}

module.exports = { createSites, generateReadings, START, INTERVAL_MS, SAMPLES, EXPECTED };
