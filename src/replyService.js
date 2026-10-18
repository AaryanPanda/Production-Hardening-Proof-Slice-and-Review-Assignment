'use strict';

// Connects the circuit breaker to a real risk: PromptPilot drafts a support
// reply by calling an external model provider. When the provider is failing,
// the breaker short-circuits and the service degrades safely instead of
// piling up doomed calls.

const { createCircuitBreaker, CircuitOpenError } = require('./circuitBreaker');

const FALLBACK_TEXT = 'Your ticket is queued for a human agent.';

// Structured, redaction-safe log line emitted when the breaker changes state.
// It carries ONLY the control's own state and counters — never the ticket,
// the provider's reply text, secrets, tokens, or any personal data.
function defaultBreakerLogger(breaker) {
  return function onStateChange(state) {
    const line = {
      ts: new Date().toISOString(),
      level: state === 'OPEN' ? 'warn' : 'info',
      component: 'circuit_breaker',
      service: 'promptpilot.reply',
      event: 'breaker_state_change',
      state,
      breaker_open_total: breaker.metrics.breaker_open_total,
      short_circuited_total: breaker.metrics.short_circuited_total,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };
}

function createReplyService(callProvider, options = {}) {
  // Wire an observability hook by default, but never override a caller's own
  // onStateChange (so tests that inject one keep full control). The logger
  // needs the breaker's metrics, so it is attached after creation.
  const hasCallerHook = typeof options.onStateChange === 'function';
  let breakerRef = null;
  const breaker = createCircuitBreaker({
    ...options,
    onStateChange: hasCallerHook
      ? options.onStateChange
      : (state) => defaultBreakerLogger(breakerRef)(state),
  });
  breakerRef = breaker;

  async function draftReply(ticket) {
    try {
      const text = await breaker.exec(() => callProvider(ticket));
      return { source: 'model', text };
    } catch (err) {
      // Whether the breaker short-circuited (CircuitOpenError) or the provider
      // itself failed, the critical path stays alive with a safe fallback.
      if (err instanceof CircuitOpenError) {
        return { source: 'fallback', text: FALLBACK_TEXT, reason: 'circuit_open' };
      }
      return { source: 'fallback', text: FALLBACK_TEXT, reason: 'provider_error' };
    }
  }

  return { draftReply, breaker };
}

module.exports = { createReplyService, FALLBACK_TEXT };
