// Shared numeric + time helpers used by every normalizer. Extracted verbatim
// from bagPlaybackSource.js so the existing behavior is byte-identical.

export function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function scaledNumberOrUndefined(value, factor) {
  const number = numberOrUndefined(value);
  return number === undefined ? undefined : Number((number * factor).toFixed(3));
}

export function timeToString(time) {
  if (!time || typeof time.sec !== "number") {
    return "";
  }
  return `${time.sec}.${String(time.nsec || 0).padStart(9, "0")}`;
}

export function timeToSeconds(time) {
  if (typeof time === "string" || typeof time === "number") {
    return Number(time) || 0;
  }
  if (!time || typeof time.sec !== "number") {
    return 0;
  }
  return Number(time.sec) + Number(time.nsec || 0) / 1_000_000_000;
}

export function secondsToTime(seconds) {
  const sec = Math.floor(seconds);
  return {
    sec,
    nsec: Math.round((seconds - sec) * 1_000_000_000),
  };
}

// ROS header.stamp -> ISO-8601 string. Falls back to current wall time when the
// stamp is missing or zero; callers can substitute their own clock if needed.
export function rosTimeToString(stamp) {
  if (!stamp || typeof stamp !== "object") {
    return new Date().toISOString();
  }
  const sec = Number(stamp.sec || stamp.secs || 0);
  const nsec = Number(stamp.nsec || stamp.nsecs || 0);
  if (!sec) {
    return new Date().toISOString();
  }
  return new Date(sec * 1000 + Math.round(nsec / 1_000_000)).toISOString();
}
