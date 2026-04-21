'use strict';

const loggerModule = require('../logger');

class BankConnector {
  constructor(simulator) {
    this.simulator = simulator;
    this.log = loggerModule.child('BankConnector');
  }

  async authorize({ txnId, traceId, amount, method }) {
    const outcome = this.simulator.rollOutcome();
    const latencyMs = this.simulator.rollLatencyMs(outcome);

    this.log.debug(
      { traceId, txnId, method, amount, plannedLatencyMs: latencyMs, outcomeRc: outcome.rc },
      'upstream authorize call dispatched'
    );

    await sleep(latencyMs);

    const payload = {
      txnId,
      traceId,
      method,
      amount,
      rc: outcome.rc,
      message: outcome.message,
      latencyMs,
      upstream: pickUpstream(method)
    };

    if (outcome.success) {
      this.log.info(payload, 'upstream authorize approved');
    } else if (outcome.level === 'warn') {
      this.log.warn(payload, 'upstream authorize declined');
    } else {
      this.log.error(payload, 'upstream authorize failed');
    }

    return { outcome, latencyMs };
  }
}

function pickUpstream(method) {
  if (method.startsWith('VA_')) {
    return method.replace('VA_', 'BANK_');
  }
  if (method === 'QRIS') {
    return 'ASPI_QRIS_SWITCH';
  }
  if (method === 'CREDIT_CARD') {
    return 'VISA_MC_ACQUIRER';
  }
  return method;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = BankConnector;
