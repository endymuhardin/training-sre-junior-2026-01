'use strict';

const pino = require('pino');
const path = require('path');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

function lowerLevel(a, b) {
  if (!LEVELS.includes(a)) {
    throw new Error(`Invalid log level: ${a}`);
  }
  if (!LEVELS.includes(b)) {
    throw new Error(`Invalid log level: ${b}`);
  }
  return LEVELS.indexOf(a) < LEVELS.indexOf(b) ? a : b;
}

let rootLogger = null;

function build(cfg) {
  if (rootLogger) {
    throw new Error('Logger has already been initialized');
  }

  const appLogAbs = path.resolve(process.cwd(), cfg.logging.appLogPath);

  const streams = [
    {
      level: cfg.logging.fileLevel,
      stream: pino.destination({ dest: appLogAbs, sync: false, mkdir: true })
    },
    {
      level: cfg.logging.consoleLevel,
      stream: process.stdout
    }
  ];

  const rootLevel = lowerLevel(cfg.logging.fileLevel, cfg.logging.consoleLevel);

  rootLogger = pino(
    {
      level: rootLevel,
      base: { service: 'payment-gateway', pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.multistream(streams)
  );

  return rootLogger;
}

function child(loggerName) {
  if (!rootLogger) {
    throw new Error('Logger not initialized. Call build(cfg) first.');
  }
  return rootLogger.child({ logger: loggerName });
}

function getRoot() {
  if (!rootLogger) {
    throw new Error('Logger not initialized. Call build(cfg) first.');
  }
  return rootLogger;
}

module.exports = { build, child, getRoot };
