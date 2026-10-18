# Circuit Breaker Proof Slice — PromptPilot

**Option B (provided scenario).** One production-safety control — a **circuit breaker** around
PromptPilot's external model provider — implemented, tested, and observable.

## Proof-slice answers

1. **Risk** — When the model provider is slow or failing, every reply request keeps calling it, so
   doomed calls pile up, exhaust connections/threads, and the failure spreads across PromptPilot.

2. **Control** — A circuit breaker in [`src/circuitBreaker.js`](./src/circuitBreaker.js), wired into
   the reply path in [`src/replyService.js`](./src/replyService.js). It trips `OPEN` on a sustained
   failure rate, short-circuits to a safe fallback, and probes once (`HALF_OPEN`) to recover.

3. **Run / test** — `node --test` (Node 18+). **Expected:** `# pass 8` / `# fail 0` — all 8 tests
   pass.

4. **Evidence** — [`test/circuitBreaker.test.js`](./test/circuitBreaker.test.js) proves the state
   machine (closed under low volume → opens on threshold → short-circuits without calling the
   dependency → probes and closes on success → re-opens on a failed probe → emits the
   `OPEN → HALF_OPEN → CLOSED` transitions). [`test/replyService.test.js`](./test/replyService.test.js)
   proves the reply path returns a model draft while healthy and a safe fallback once the circuit
   opens. A reviewer confirms it with one command: `node --test`.

5. **Observability** — Two signals. **Metric:** `metrics.breaker_open_total` increments on every
   trip and `metrics.short_circuited_total` on every fast-fail. **Log:** on each state change the
   reply service emits a structured line, e.g.
   `{"level":"warn","component":"circuit_breaker","event":"breaker_state_change","state":"OPEN","breaker_open_total":1,...}`.
   The line carries only the control's state and counters — **never the ticket, provider reply,
   secrets, tokens, or personal data.**

6. **Trade-off** — While `OPEN`, healthy requests are also refused (served the fallback) for up to
   `openMillis`, and a single `HALF_OPEN` probe can still fail a real user. The breaker trades a
   small amount of availability-to-the-provider for protection of the whole service.

7. **Remaining risk** — It guards one dependency with a simple count-ratio window (no rolling
   time-window, no per-endpoint breakers, no bulkheads/retries). It does not fix the provider, does
   not cover partial/slow-but-successful responses, and shared in-process state is per-instance only.

8. **Design link (Modules 1–3)** — This protects the earlier decision to draft replies via an
   **external provider on the synchronous request path**. The breaker keeps that dependency from
   turning a provider outage into a PromptPilot outage, preserving the "degrade to a human-agent
   fallback" contract that design assumed.

## How the breaker behaves

```
CLOSED ──(failures/calls ≥ threshold AND calls ≥ minimumRequests)──▶ OPEN
  ▲                                                                   │
  │ probe succeeds                                 openMillis elapsed │
  └──────────────── HALF_OPEN ◀───────────────────────────────────────┘
                       │ probe fails ──▶ OPEN
```

- **CLOSED** — calls pass through; calls and failures are counted.
- **OPEN** — within `openMillis`, calls short-circuit with `CircuitOpenError` (the dependency is
  never called) and `short_circuited_total` increments.
- **HALF_OPEN** — after `openMillis`, one probe is allowed: success closes the breaker and resets the
  counts; failure re-opens it and increments `breaker_open_total`.

Tunable via options: `failureThreshold`, `minimumRequests`, `openMillis`, `now` (injectable clock),
`onStateChange`.

## Test output

```text
ok 1 - stays closed below the minimum request volume
ok 2 - opens once failures cross the threshold with enough volume
ok 3 - short-circuits without calling the dependency while open
ok 4 - probes after the open window and closes on a successful probe
ok 5 - a failed probe re-opens the circuit
ok 6 - reports state changes for observability
ok 7 - returns a model draft while the provider is healthy
ok 8 - degrades to a safe fallback once the circuit opens
# tests 8
# pass 8
# fail 0
```
