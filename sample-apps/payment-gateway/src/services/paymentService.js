'use strict';

const loggerModule = require('../logger');

class PaymentService {
  constructor(simulator, bankConnector) {
    this.simulator = simulator;
    this.bank = bankConnector;
    this.log = loggerModule.child('PaymentService');
  }

  async processPayment({ amount, method, customerId }) {
    const txnId = this.simulator.nextTxnId();
    const traceId = this.simulator.newTraceId();
    const startedAt = Date.now();

    this.log.info(
      { traceId, txnId, customerId, amount, method },
      'payment request received'
    );

    const { outcome, latencyMs } = await this.bank.authorize({
      txnId, traceId, amount, method
    });

    const totalLatencyMs = Date.now() - startedAt;

    const record = {
      traceId,
      txnId,
      customerId,
      amount,
      method,
      rc: outcome.rc,
      status: outcome.success ? 'SUCCESS' : 'FAILED',
      message: outcome.message,
      bankLatencyMs: latencyMs,
      totalLatencyMs
    };

    if (outcome.success) {
      this.log.info(record, 'payment approved');
    } else if (outcome.level === 'warn') {
      this.log.warn(record, 'payment declined');
    } else {
      this.log.error(record, 'payment failed');
    }

    return { record, outcome };
  }
}

module.exports = PaymentService;
