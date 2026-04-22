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

    let cpuBurnMs = 0;
    let cpuDigest = null;
    if (this.simulator.shouldBurnCpu()) {
      const cpuStart = Date.now();
      cpuDigest = this.simulator.burnCpu();
      cpuBurnMs = Date.now() - cpuStart;
      this.log.warn(
        {
          traceId,
          txnId,
          cpuBurnMs,
          hashRounds: this.simulator.cfg.simulation.cpu.hashRounds,
          digestSample: cpuDigest
        },
        'cpu-intensive fraud scoring executed'
      );
    }

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
      cpuBurnMs,
      totalLatencyMs
    };

    const retained = this.simulator.retainRecord(record);
    if (retained) {
      record.retained = true;
    }

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
