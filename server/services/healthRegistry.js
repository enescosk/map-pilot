// Topic-level health registry with rate-limited logging.
//
// Phase-3 responsibilities:
//   - Count ok / error events per topic.
//   - Throttle console.* output to at most one line per topic per cooldown
//     window so a malformed publisher cannot flood the log.
//
// This is intentionally tiny. Phase 4 will hang structured snapshots off it
// (per-topic rates, last error string, etc.) and surface them via the bus.

const DEFAULT_COOLDOWN_MS = 10_000;

function createRegistry({ cooldownMs = DEFAULT_COOLDOWN_MS, logger = console } = {}) {
  const stats = new Map();

  function entryFor(topic) {
    let e = stats.get(topic);
    if (!e) {
      e = { ok: 0, errors: 0, lastLogMs: 0, lastError: undefined, invalidCount: 0 };
      stats.set(topic, e);
    }
    return e;
  }

  function canLog(entry, now) {
    if (now - entry.lastLogMs >= cooldownMs) {
      entry.lastLogMs = now;
      return true;
    }
    return false;
  }

  function recordOk(topic, invalidCount = 0) {
    const e = entryFor(topic);
    e.ok += 1;
    e.invalidCount += invalidCount;
    if (invalidCount > 0) {
      const now = Date.now();
      if (canLog(e, now)) {
        logger.warn?.(`[health] ${topic}: ${invalidCount} field(s) out of range`);
      }
    }
  }

  function recordError(topic, reason) {
    const e = entryFor(topic);
    e.errors += 1;
    e.lastError = reason;
    const now = Date.now();
    if (canLog(e, now)) {
      logger.warn?.(`[health] ${topic}: ${reason}`);
    }
  }

  function snapshot() {
    const out = {};
    for (const [topic, e] of stats.entries()) {
      out[topic] = {
        ok: e.ok,
        errors: e.errors,
        invalidCount: e.invalidCount,
        lastError: e.lastError,
      };
    }
    return out;
  }

  function reset() {
    stats.clear();
  }

  return { recordOk, recordError, snapshot, reset };
}

export const healthRegistry = createRegistry();
export { createRegistry };
