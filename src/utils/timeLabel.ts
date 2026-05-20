export function timeStringToSeconds(time?: string) {
  if (!time) {
    return 0;
  }

  return Number(time) || 0;
}

export function timeLabel(time?: string) {
  if (!time) {
    return "--";
  }

  const [, fraction = ""] = time.split(".");
  return fraction.slice(0, 3) || time.slice(-6);
}
