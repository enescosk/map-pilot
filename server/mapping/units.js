// Unit conversions used by topic extractors. All conversions return finite numbers
// or undefined; callers decide how to surface NaN/missing values.

export function mpsToKmh(mps) {
  const n = Number(mps);
  if (!Number.isFinite(n)) return undefined;
  return Number((n * 3.6).toFixed(3));
}

export function kmhToMps(kmh) {
  const n = Number(kmh);
  if (!Number.isFinite(n)) return undefined;
  return Number((n / 3.6).toFixed(3));
}

export function radToDeg(rad) {
  const n = Number(rad);
  if (!Number.isFinite(n)) return undefined;
  return Number(((n * 180) / Math.PI).toFixed(3));
}

export function degToRad(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return undefined;
  return Number(((n * Math.PI) / 180).toFixed(6));
}
