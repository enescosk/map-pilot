// Centralized process.env reads for values shared across normalizers and sources.
// Source-specific env vars (BAG_*, ROSBRIDGE_URL, etc.) stay in the source that uses them.

export const MAX_SCAN_POINTS = Number(process.env.MAX_SCAN_POINTS || 720);
export const MAX_POINT_CLOUD_POINTS = Number(process.env.MAX_POINT_CLOUD_POINTS || 80000);
