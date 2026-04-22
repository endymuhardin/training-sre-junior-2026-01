'use strict';

const crypto = require('crypto');

class Simulator {
  constructor(cfg) {
    this.cfg = cfg;
    this._rebuildWeights();
    this.txnCounter = 0;
    this.retained = new Map();
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

  setCpu(partial) {
    if (!partial || typeof partial !== 'object') {
      throw new Error('cpu config must be an object');
    }
    const next = { ...this.cfg.simulation.cpu };
    if ('enabled' in partial) {
      if (typeof partial.enabled !== 'boolean') {
        throw new Error('cpu.enabled must be a boolean');
      }
      next.enabled = partial.enabled;
    }
    if ('probability' in partial) {
      if (typeof partial.probability !== 'number' || partial.probability < 0 || partial.probability > 1) {
        throw new Error(`cpu.probability must be a number in [0,1], got: ${partial.probability}`);
      }
      next.probability = partial.probability;
    }
    if ('hashRounds' in partial) {
      if (!Number.isInteger(partial.hashRounds) || partial.hashRounds < 0) {
        throw new Error(`cpu.hashRounds must be a non-negative integer, got: ${partial.hashRounds}`);
      }
      next.hashRounds = partial.hashRounds;
    }
    this.cfg.simulation.cpu = next;
    return next;
  }

  setMemory(partial) {
    if (!partial || typeof partial !== 'object') {
      throw new Error('memory config must be an object');
    }
    const next = { ...this.cfg.simulation.memory };
    if ('retainRecords' in partial) {
      if (typeof partial.retainRecords !== 'boolean') {
        throw new Error('memory.retainRecords must be a boolean');
      }
      next.retainRecords = partial.retainRecords;
    }
    if ('maxRecords' in partial) {
      if (!Number.isInteger(partial.maxRecords) || partial.maxRecords <= 0) {
        throw new Error(`memory.maxRecords must be a positive integer, got: ${partial.maxRecords}`);
      }
      next.maxRecords = partial.maxRecords;
    }
    if ('payloadKb' in partial) {
      if (!Number.isInteger(partial.payloadKb) || partial.payloadKb < 0) {
        throw new Error(`memory.payloadKb must be a non-negative integer, got: ${partial.payloadKb}`);
      }
      next.payloadKb = partial.payloadKb;
    }
    this.cfg.simulation.memory = next;
    return next;
  }

  clearRetained() {
    const dropped = this.retained.size;
    this.retained.clear();
    return dropped;
  }

  shouldBurnCpu() {
    const c = this.cfg.simulation.cpu;
    if (!c.enabled || c.hashRounds === 0) return false;
    return Math.random() < c.probability;
  }

  burnCpu() {
    const rounds = this.cfg.simulation.cpu.hashRounds;
    let buf = crypto.randomBytes(64);
    for (let i = 0; i < rounds; i += 1) {
      buf = crypto.createHash('sha256').update(buf).digest();
    }
    return buf.toString('hex').slice(0, 16);
  }

  retainRecord(record) {
    const m = this.cfg.simulation.memory;
    if (!m.retainRecords) return false;
    if (this.retained.size >= m.maxRecords) return false;
    const payload = m.payloadKb > 0 ? Buffer.alloc(m.payloadKb * 1024, 0x61) : null;
    this.retained.set(record.txnId, { record, payload, at: Date.now() });
    return true;
  }

  getMetrics() {
    const mu = process.memoryUsage();
    const cu = process.cpuUsage();
    return {
      retainedRecords: this.retained.size,
      memoryUsage: {
        rssMb: +(mu.rss / (1024 * 1024)).toFixed(2),
        heapUsedMb: +(mu.heapUsed / (1024 * 1024)).toFixed(2),
        heapTotalMb: +(mu.heapTotal / (1024 * 1024)).toFixed(2),
        externalMb: +(mu.external / (1024 * 1024)).toFixed(2),
        arrayBuffersMb: +(mu.arrayBuffers / (1024 * 1024)).toFixed(2)
      },
      cpuUsage: {
        userMs: +(cu.user / 1000).toFixed(2),
        systemMs: +(cu.system / 1000).toFixed(2)
      },
      uptimeSec: Math.floor(process.uptime())
    };
  }

  getState() {
    return {
      successRate: this.cfg.simulation.successRate,
      errorDistribution: this.cfg.simulation.errorDistribution,
      latencyMs: this.cfg.simulation.latencyMs,
      methods: this.cfg.simulation.methods,
      cpu: this.cfg.simulation.cpu,
      memory: this.cfg.simulation.memory
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
