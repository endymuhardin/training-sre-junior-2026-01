'use strict';

const crypto = require('crypto');

class Simulator {
  constructor(cfg) {
    this.cfg = cfg;
    this._rebuildWeights();
    this.txnCounter = 0;
  }

  _rebuildWeights() {
    this.totalWeight = this.cfg.simulation.errorDistribution
      .reduce((s, e) => s + e.weight, 0);
    if (this.totalWeight <= 0) {
      throw new Error('errorDistribution total weight must be > 0');
    }
  }

  setSuccessRate(rate) {
    if (typeof rate !== 'number' || rate < 0 || rate > 1) {
      throw new Error(`successRate must be a number in [0,1], got: ${rate}`);
    }
    this.cfg.simulation.successRate = rate;
  }

  setErrorDistribution(dist) {
    if (!Array.isArray(dist) || dist.length === 0) {
      throw new Error('errorDistribution must be a non-empty array');
    }
    for (const e of dist) {
      for (const k of ['rc', 'weight', 'message', 'level', 'httpStatus']) {
        if (!(k in e)) {
          throw new Error(`errorDistribution entry missing key '${k}': ${JSON.stringify(e)}`);
        }
      }
      if (typeof e.weight !== 'number' || e.weight <= 0) {
        throw new Error(`errorDistribution weight must be positive (rc=${e.rc})`);
      }
      if (!['info', 'warn', 'error'].includes(e.level)) {
        throw new Error(`errorDistribution level must be info|warn|error (rc=${e.rc})`);
      }
    }
    this.cfg.simulation.errorDistribution = dist;
    this._rebuildWeights();
  }

  getState() {
    return {
      successRate: this.cfg.simulation.successRate,
      errorDistribution: this.cfg.simulation.errorDistribution,
      latencyMs: this.cfg.simulation.latencyMs,
      methods: this.cfg.simulation.methods
    };
  }

  nextTxnId() {
    this.txnCounter += 1;
    return `TXN-${Date.now()}-${this.txnCounter}`;
  }

  newTraceId() {
    return crypto.randomBytes(8).toString('hex');
  }

  rollOutcome() {
    const roll = Math.random();
    if (roll < this.cfg.simulation.successRate) {
      return { success: true, rc: '00', message: 'Approved', level: 'info', httpStatus: 200 };
    }
    return this._pickError();
  }

  _pickError() {
    const pool = this.cfg.simulation.errorDistribution;
    let r = Math.random() * this.totalWeight;
    for (const e of pool) {
      r -= e.weight;
      if (r <= 0) {
        return {
          success: false,
          rc: e.rc,
          message: e.message,
          level: e.level,
          httpStatus: e.httpStatus,
          simulateTimeout: !!e.simulateTimeout
        };
      }
    }
    throw new Error('Weighted selection failed to pick an entry');
  }

  rollLatencyMs(outcome) {
    const lat = this.cfg.simulation.latencyMs;
    if (outcome.simulateTimeout) {
      return this._randInt(lat.timeoutMin, lat.timeoutMax);
    }
    return this._randInt(lat.baseMin, lat.baseMax);
  }

  _randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}

module.exports = Simulator;
