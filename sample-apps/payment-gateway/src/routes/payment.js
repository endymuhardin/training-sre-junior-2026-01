'use strict';

const express = require('express');
const loggerModule = require('../logger');

function buildPaymentRouter(paymentService, simulator) {
  const router = express.Router();
  const log = loggerModule.child('PaymentController');

  router.post('/payment', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      log.warn({ body }, 'rejected: body missing or not an object');
      return res.status(400).json({ error: 'body must be a JSON object' });
    }
    const { amount, method, customerId } = body;

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      log.warn({ body }, 'rejected: amount must be a positive number');
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (typeof method !== 'string' || !simulator.cfg.simulation.methods.includes(method)) {
      log.warn({ body, allowed: simulator.cfg.simulation.methods }, 'rejected: invalid payment method');
      return res.status(400).json({
        error: 'invalid method',
        allowed: simulator.cfg.simulation.methods
      });
    }
    if (customerId !== undefined && typeof customerId !== 'string') {
      log.warn({ body }, 'rejected: customerId must be a string when provided');
      return res.status(400).json({ error: 'customerId must be a string' });
    }

    const { record, outcome } = await paymentService.processPayment({
      amount, method, customerId
    });

    res.status(outcome.httpStatus).json({
      txnId: record.txnId,
      traceId: record.traceId,
      status: record.status,
      rc: record.rc,
      message: record.message,
      latencyMs: record.totalLatencyMs
    });
  });

  return router;
}

function buildAdminRouter(simulator) {
  const router = express.Router();
  const log = loggerModule.child('AdminController');

  router.get('/config', (req, res) => {
    res.json(simulator.getState());
  });

  router.put('/config/success-rate', (req, res) => {
    const rate = req.body && req.body.successRate;
    try {
      simulator.setSuccessRate(rate);
      log.warn({ successRate: rate }, 'success rate changed at runtime');
      res.json({ successRate: rate });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/config/error-distribution', (req, res) => {
    const dist = req.body && req.body.errorDistribution;
    try {
      simulator.setErrorDistribution(dist);
      log.warn(
        { errorDistribution: dist },
        'error distribution changed at runtime'
      );
      res.json({ errorDistribution: dist });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/config/cpu', (req, res) => {
    try {
      const next = simulator.setCpu(req.body || {});
      log.warn({ cpu: next }, 'cpu simulation config changed at runtime');
      res.json({ cpu: next });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/config/memory', (req, res) => {
    try {
      const next = simulator.setMemory(req.body || {});
      log.warn({ memory: next }, 'memory simulation config changed at runtime');
      res.json({ memory: next });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/memory/clear', (req, res) => {
    const dropped = simulator.clearRetained();
    log.warn({ dropped }, 'retained records cleared');
    res.json({ dropped });
  });

  router.get('/metrics', (req, res) => {
    res.json(simulator.getMetrics());
  });

  return router;
}

function buildHealthRouter() {
  const router = express.Router();
  router.get('/health', (req, res) => {
    res.json({ status: 'UP', pid: process.pid, uptimeSec: Math.floor(process.uptime()) });
  });
  return router;
}

module.exports = { buildPaymentRouter, buildAdminRouter, buildHealthRouter };
