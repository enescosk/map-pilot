export function timeStringToSeconds(time?: string | number) {
  if (time === undefined || time === null || time === "") {
    return 0;
  }

  return Number(time) || 0;
}

export function timeLabel(time?: string | number) {
  if (time === undefined || time === null || time === "") {
    return "--";
  }

  const str = String(time);
  const [, fraction = ""] = str.split(".");
  return fraction.slice(0, 3) || str.slice(-6);
}
