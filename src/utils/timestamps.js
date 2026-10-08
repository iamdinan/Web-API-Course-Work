// Explicit timezone and millisecond precision match BSON Date storage. Reject
// calendar overflow rather than allowing Date.parse to normalize invalid dates.
function parseRecordedAt(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][+month - 1];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59 ||
      (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const colomboOffsetMs = 330 * 60 * 1000;
function colomboTimestamp(value) {
  return new Date(new Date(value).getTime() + colomboOffsetMs).toISOString().replace("Z", "+05:30");
}
function colomboDayStart(value) {
  const local = new Date(new Date(value).getTime() + colomboOffsetMs);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - colomboOffsetMs);
}

const displayTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Colombo", day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h12",
});

function displayTimestamp(value) {
  const parts = Object.fromEntries(displayTime.formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod.toUpperCase()} (Sri Lanka)`;
}

module.exports = { parseRecordedAt, colomboTimestamp, colomboDayStart, displayTimestamp };
