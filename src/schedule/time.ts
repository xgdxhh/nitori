import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export function normalizeScheduledRunAt(at: string, timezoneName?: string): string {
  const raw = at.trim();
  if (!raw) {
    throw new Error("one-shot event requires 'at'");
  }

  const now = dayjs();
  const absolute = dayjs(raw);
  if (absolute.isValid()) {
    return ensureFutureOneShot(absolute, raw).toISOString();
  }

  const hm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
  if (!hm) {
    throw new Error(`Invalid one-shot time format: ${raw}`);
  }

  const tz = String(timezoneName || dayjs.tz.guess() || "UTC").trim() || "UTC";
  const today = dayjs().tz(tz).format("YYYY-MM-DD");
  let candidate = dayjs.tz(`${today} ${raw}`, "YYYY-MM-DD HH:mm", tz);
  if (!candidate.isValid()) {
    throw new Error(`Invalid one-shot time format: ${raw}`);
  }
  if (!candidate.isAfter(now)) {
    candidate = candidate.add(1, "day");
  }

  return ensureFutureOneShot(candidate, raw).toISOString();
}

function ensureFutureOneShot(candidate: dayjs.Dayjs, rawInput: string): dayjs.Dayjs {
  const now = dayjs();
  if (!candidate.isAfter(now)) {
    throw new Error(
      `one-shot 'at' must be in the future. got='${rawInput}' resolved='${candidate.toISOString()}' now='${now.toISOString()}'`,
    );
  }
  return candidate;
}
