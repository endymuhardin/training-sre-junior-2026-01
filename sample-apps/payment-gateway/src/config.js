'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.PG_CONFIG_PATH
  || path.resolve(__dirname, '..', 'config', 'default.json');

function requireKey(obj, keyPath) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) {
      throw new Error(`Missing required config key: ${keyPath} (in ${CONFIG_PATH})`);
    }
    cur = cur[p];
  }
  if (cur === null || cur === undefined) {
    throw new Error(`Config key ${keyPath} must not be null/undefined`);
  }
  return cur;
}

function validate(cfg) {
  requireKey(cfg, 'server.port');
  requireKey(cfg, 'server.host');
  requireKey(cfg, 'logging.appLogPath');
  requireKey(cfg, 'logging.accessLogPath');
  requireKey(cfg, 'logging.consoleLevel');
  requireKey(cfg, 'logging.fileLevel');

  const rate = requireKey(cfg, 'simulation.successRate');
  if (typeof rate !== 'number' || rate < 0 || rate > 1) {
    throw new Error(`simulation.successRate must be a number between 0 and 1, got: ${rate}`);
  }

  const lat = requireKey(cfg, 'simulation.latencyMs');
  for (const k of ['baseMin', 'baseMax', 'timeoutMin', 'timeoutMax']) {
    if (typeof lat[k] !== 'number' || lat[k] < 0) {
      throw new Error(`simulation.latencyMs.${k} must be a non-negative number`);
    }
  }
  if (lat.baseMin > lat.baseMax) {
    throw new Error('simulation.latencyMs.baseMin must be <= baseMax');
  }
  if (lat.timeoutMin > lat.timeoutMax) {
    throw new Error('simulation.latencyMs.timeoutMin must be <= timeoutMax');
  }

  const dist = requireKey(cfg, 'simulation.errorDistribution');
  if (!Array.isArray(dist) || dist.length === 0) {
    throw new Error('simulation.errorDistribution must be a non-empty array');
  }
  for (const e of dist) {
    for (const k of ['rc', 'weight', 'message', 'level', 'httpStatus']) {
      if (!(k in e)) {
        throw new Error(`Each errorDistribution entry must define '${k}' (offending entry: ${JSON.stringify(e)})`);
      }
    }
    if (typeof e.weight !== 'number' || e.weight <= 0) {
      throw new Error(`errorDistribution weight must be a positive number (rc=${e.rc})`);
    }
    if (!['info', 'warn', 'error'].includes(e.level)) {
      throw new Error(`errorDistribution level must be info|warn|error (rc=${e.rc}, got=${e.level})`);
    }
  }

  const methods = requireKey(cfg, 'simulation.methods');
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new Error('simulation.methods must be a non-empty array');
  }

  const cpu = requireKey(cfg, 'simulation.cpu');
  if (typeof cpu.enabled !== 'boolean') {
    throw new Error('simulation.cpu.enabled must be a boolean');
  }
  if (typeof cpu.probability !== 'number' || cpu.probability < 0 || cpu.probability > 1) {
    throw new Error(`simulation.cpu.probability must be a number in [0,1], got: ${cpu.probability}`);
  }
  if (!Number.isInteger(cpu.hashRounds) || cpu.hashRounds < 0) {
    throw new Error(`simulation.cpu.hashRounds must be a non-negative integer, got: ${cpu.hashRounds}`);
  }

  const mem = requireKey(cfg, 'simulation.memory');
  if (typeof mem.retainRecords !== 'boolean') {
    throw new Error('simulation.memory.retainRecords must be a boolean');
  }
  if (!Number.isInteger(mem.maxRecords) || mem.maxRecords <= 0) {
    throw new Error(`simulation.memory.maxRecords must be a positive integer, got: ${mem.maxRecords}`);
  }
  if (!Number.isInteger(mem.payloadKb) || mem.payloadKb < 0) {
    throw new Error(`simulation.memory.payloadKb must be a non-negative integer, got: ${mem.payloadKb}`);
  }
}

function applyEnvOverrides(cfg) {
  if (process.env.PG_PORT !== undefined) {
    const p = Number(process.env.PG_PORT);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      throw new Error(`PG_PORT env var invalid: ${process.env.PG_PORT}`);
    }
    cfg.server.port = p;
  }
  if (process.env.PG_HOST !== undefined) {
    cfg.server.host = process.env.PG_HOST;
  }
  if (process.env.PG_SUCCESS_RATE !== undefined) {
    const r = Number(process.env.PG_SUCCESS_RATE);
    if (Number.isNaN(r) || r < 0 || r > 1) {
      throw new Error(`PG_SUCCESS_RATE env var invalid: ${process.env.PG_SUCCESS_RATE}`);
    }
    cfg.simulation.successRate = r;
  }
  if (process.env.PG_APP_LOG !== undefined) {
    cfg.logging.appLogPath = process.env.PG_APP_LOG;
  }
  if (process.env.PG_ACCESS_LOG !== undefined) {
    cfg.logging.accessLogPath = process.env.PG_ACCESS_LOG;
  }
}

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Config file not found at ${CONFIG_PATH}. Set PG_CONFIG_PATH to override.`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config file ${CONFIG_PATH} is not valid JSON: ${e.message}`);
  }
  applyEnvOverrides(cfg);
  validate(cfg);

  const logDir = path.dirname(path.resolve(process.cwd(), cfg.logging.appLogPath));
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const accessDir = path.dirname(path.resolve(process.cwd(), cfg.logging.accessLogPath));
  if (!fs.existsSync(accessDir)) {
    fs.mkdirSync(accessDir, { recursive: true });
  }

  return cfg;
}

module.exports = { load, CONFIG_PATH };
