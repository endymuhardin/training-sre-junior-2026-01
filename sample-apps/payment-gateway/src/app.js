'use strict';

const express = require('express');
const pinoHttp = require('pino-http');

const configModule = require('./config');
const loggerModule = require('./logger');
const Simulator = require('./services/simulator');
const BankConnector = require('./services/bankConnector');
const PaymentService = require('./services/paymentService');
const {
  buildPaymentRouter,
  buildAdminRouter,
  buildHealthRouter
} = require('./routes/payment');

function main() {
  const cfg = configModule.load();
  const rootLogger = loggerModule.build(cfg);

  rootLogger.info(
    {
      configPath: configModule.CONFIG_PATH,
      successRate: cfg.simulation.successRate,
      errorRcs: cfg.simulation.errorDistribution.map((e) => e.rc),
      methods: cfg.simulation.methods
    },
    'payment gateway simulator starting'
  );

  const simulator = new Simulator(cfg);
  const bank = new BankConnector(simulator);
  const paymentService = new PaymentService(simulator, bank);

  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger: loggerModule.child('HttpAccess'),
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress
        }),
        res: (res) => ({ statusCode: res.statusCode })
      }
    })
  );

  app.use(express.json({ limit: '64kb' }));

  app.use('/api', buildHealthRouter());
  app.use('/api', buildPaymentRouter(paymentService, simulator));
  app.use('/api/admin', buildAdminRouter(simulator));

  app.use((err, req, res, next) => {
    rootLogger.error(
      { err, url: req.url, method: req.method },
      'unhandled error'
    );
    res.status(500).json({ error: 'internal error' });
  });

  const server = app.listen(cfg.server.port, cfg.server.host, () => {
    rootLogger.info(
      { host: cfg.server.host, port: cfg.server.port },
      'listening'
    );
  });

  function shutdown(signal) {
    rootLogger.info({ signal }, 'shutdown signal received');
    server.close(() => {
      rootLogger.info({}, 'http server closed, exiting');
      process.exit(0);
    });
    setTimeout(() => {
      rootLogger.error({}, 'forced exit after shutdown timeout');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
