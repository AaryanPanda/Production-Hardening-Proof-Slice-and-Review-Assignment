'use strict';

// Circuit breaker around PromptPilot's model provider.
//
// Risk: when the provider is slow or failing, every request keeps calling it,
// so doomed calls pile up, exhaust resources, and the failure spreads. This
// breaker detects a sustained failure rate, trips OPEN to short-circuit fast to
// a safe fallback, then probes once after a cool-down to recover automatically.
//
// States:  CLOSED ──trip──▶ OPEN ──cool-down──▶ HALF_OPEN ──probe ok──▶ CLOSED
//                                         ▲                   └─probe fail─┘
//                                         └──────────────────────────────┘
//
// Behaviour is fully specified by test/circuitBreaker.test.js (do not modify).

class CircuitOpenError extends Error {
  constructor() {
    super('circuit is open');
    this.code = 'CIRCUIT_OPEN';
  }
}

function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? 0.5;
  const minimumRequests = options.minimumRequests ?? 20;
  const openMillis = options.openMillis ?? 30000;
  const now = options.now ?? Date.now;
  const onStateChange = options.onStateChange ?? function () {};

  const metrics = {
    breaker_open_total: 0,
    short_circuited_total: 0,
    success_total: 0,
    failure_total: 0,
  };

  let state = 'CLOSED';
  let calls = 0;      // calls counted in the current CLOSED window
  let failures = 0;   // failures counted in the current CLOSED window
  let openedAt = 0;   // now() at the moment the breaker last tripped OPEN

  function changeTo(next) {
    state = next;
    onStateChange(state);
  }

  function trip() {
    openedAt = now();
    metrics.breaker_open_total += 1;
    changeTo('OPEN');
  }

  function reset() {
    calls = 0;
    failures = 0;
  }

  async function exec(fn) {
    // ---- OPEN: either short-circuit, or allow a single HALF_OPEN probe. ----
    if (state === 'OPEN') {
      if (now() - openedAt < openMillis) {
        // Still cooling down: fail fast WITHOUT touching the dependency.
        metrics.short_circuited_total += 1;
        throw new CircuitOpenError();
      }
      // Cool-down elapsed: let exactly one probe through.
      changeTo('HALF_OPEN');
      try {
        const result = await fn();
        metrics.success_total += 1;
        reset();
        changeTo('CLOSED'); // probe succeeded — provider looks healthy again
        return result;
      } catch (err) {
        metrics.failure_total += 1;
        trip(); // probe failed — straight back to OPEN
        throw err;
      }
    }

    // ---- CLOSED (or HALF_OPEN reached only via the branch above): run it. --
    try {
      const result = await fn();
      metrics.success_total += 1;
      calls += 1;
      return result;
    } catch (err) {
      metrics.failure_total += 1;
      calls += 1;
      failures += 1;
      // Trip only with enough volume AND a failure rate at/above the threshold.
      if (calls >= minimumRequests && failures / calls >= failureThreshold) {
        trip();
      }
      throw err;
    }
  }

  return {
    exec,
    metrics,
    get state() {
      return state;
    },
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
