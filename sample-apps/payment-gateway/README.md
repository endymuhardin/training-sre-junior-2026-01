# Payment Gateway Simulator

Express.js app that simulates a payment gateway API. Designed to be hit by load
testing tools and produce JSON-structured logs for later analysis.

## Stack

- Node.js >= 18
- [express](https://expressjs.com/) — HTTP framework
- [pino](https://getpino.io/) + [pino-http](https://github.com/pinojs/pino-http) — structured JSON logging (Node.js equivalent of logback)

## Install & Run

```bash
cd sample-apps/payment-gateway
npm install
npm start
```

Server binds to `0.0.0.0:3000` by default. Logs go to:

- `logs/payment-app.log` — application logs (JSON lines)
- stdout — same records, for `docker logs` / `journalctl`

## API

### `POST /api/payment`

Request:
```json
{
  "amount": 50000,
  "method": "QRIS",
  "customerId": "cust-001"
}
```

- `amount`: positive number (IDR, integer recommended)
- `method`: one of `QRIS`, `VA_BCA`, `VA_BSI`, `VA_MANDIRI`, `CREDIT_CARD`, `GOPAY`, `OVO`
- `customerId`: optional string

Response (HTTP status mirrors outcome — `200`, `401`, `402`, `403`, `429`, `500`, `504`):
```json
{
  "txnId": "TXN-1713672345678-42",
  "traceId": "a1b2c3d4e5f67890",
  "status": "SUCCESS",
  "rc": "00",
  "message": "Approved",
  "latencyMs": 117
}
```

### `GET /api/health`

Liveness check. Always returns `200` with pid and uptime.

### Admin (runtime tuning)

```bash
# inspect current simulator state
curl http://localhost:3000/api/admin/config

# set success rate
curl -X PUT http://localhost:3000/api/admin/config/success-rate \
  -H 'content-type: application/json' \
  -d '{"successRate": 0.80}'

# replace the error distribution
curl -X PUT http://localhost:3000/api/admin/config/error-distribution \
  -H 'content-type: application/json' \
  -d '{"errorDistribution":[
        {"rc":"68","weight":70,"message":"Upstream Bank Timeout","level":"error","httpStatus":504,"simulateTimeout":true},
        {"rc":"51","weight":30,"message":"Insufficient Funds","level":"warn","httpStatus":402}
      ]}'
```

> The admin endpoints are unauthenticated — do not expose them outside the
> training environment.

## Tuning

All knobs live in `config/default.json`. Env vars override a subset:

| Env var             | Config key                   | Notes                          |
|---------------------|------------------------------|--------------------------------|
| `PG_CONFIG_PATH`    | path of the JSON config file | default: `config/default.json` |
| `PG_PORT`           | `server.port`                | integer 1..65535               |
| `PG_HOST`           | `server.host`                |                                |
| `PG_SUCCESS_RATE`   | `simulation.successRate`     | float 0..1                     |
| `PG_APP_LOG`        | `logging.appLogPath`         |                                |
| `PG_ACCESS_LOG`     | `logging.accessLogPath`      |                                |

The loader throws if any required key is missing or invalid — there are no
silent defaults.

### Error distribution

Each entry defines:

- `rc` — response code written into the log record
- `weight` — relative probability within the error pool
- `message` — textual reason
- `level` — `info` | `warn` | `error` (picks the pino log level)
- `httpStatus` — HTTP status returned to the caller
- `simulateTimeout` — when `true`, uses `latencyMs.timeoutMin..timeoutMax` instead of the base range

Default pool (change in `config/default.json` or via the admin endpoint):

| RC | Message                           | Level | HTTP | Timeout? |
|----|-----------------------------------|-------|------|----------|
| 51 | Insufficient Funds                | warn  | 402  |          |
| 55 | Invalid PIN / OTP                 | warn  | 401  |          |
| 61 | Daily Velocity Limit Exceeded     | warn  | 429  |          |
| 68 | Upstream Bank Timeout             | error | 504  | yes      |
| 96 | System Malfunction ISO-8583       | error | 500  |          |
| 05 | Do Not Honor (Suspected Fraud)    | error | 403  |          |

### Latency simulation

`simulation.latencyMs` controls artificial delay inside the bank connector:

- `baseMin` / `baseMax` — normal operations (both success and non-timeout errors)
- `timeoutMin` / `timeoutMax` — used when an error entry has `simulateTimeout: true`

## Log format

Pino emits one JSON object per line. Example (formatted for readability):

```json
{
  "level": 30,
  "time": "2026-04-21T12:34:56.789Z",
  "service": "payment-gateway",
  "pid": 14210,
  "logger": "PaymentService",
  "traceId": "a1b2c3d4e5f67890",
  "txnId": "TXN-1713672345678-42",
  "customerId": "cust-001",
  "amount": 50000,
  "method": "QRIS",
  "rc": "00",
  "status": "SUCCESS",
  "message": "Approved",
  "bankLatencyMs": 110,
  "totalLatencyMs": 117,
  "msg": "payment approved"
}
```

Pino numeric levels: `trace=10`, `debug=20`, `info=30`, `warn=40`, `error=50`, `fatal=60`.

Parse the log with `jq`:

```bash
# count per response code
jq -r 'select(.logger=="PaymentService") | .rc' logs/payment-app.log | sort | uniq -c

# p95 total latency
jq -r 'select(.logger=="PaymentService" and .totalLatencyMs) | .totalLatencyMs' \
  logs/payment-app.log | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END{print a[int(c*0.95)]}'

# failures only
jq -c 'select(.status=="FAILED")' logs/payment-app.log
```

## Load testing

### Apache Bench (quick smoke)

```bash
echo '{"amount":50000,"method":"QRIS"}' > /tmp/pay.json
ab -n 2000 -c 50 -p /tmp/pay.json -T application/json \
  http://localhost:3000/api/payment
```

### wrk with Lua script

`loadtest/wrk-payment.lua`:

```lua
wrk.method = "POST"
wrk.headers["Content-Type"] = "application/json"
local methods = {"QRIS","VA_BCA","VA_BSI","VA_MANDIRI","CREDIT_CARD","GOPAY","OVO"}
local amounts = {10000,25000,50000,100000,500000}
function request()
  local m = methods[math.random(#methods)]
  local a = amounts[math.random(#amounts)]
  wrk.body = string.format('{"amount":%d,"method":"%s"}', a, m)
  return wrk.format()
end
```

```bash
wrk -t4 -c100 -d60s -s loadtest/wrk-payment.lua http://localhost:3000/api/payment
```

### k6

```js
import http from 'k6/http';
import { check } from 'k6';

const methods = ['QRIS','VA_BCA','VA_BSI','VA_MANDIRI','CREDIT_CARD','GOPAY','OVO'];
const amounts = [10000,25000,50000,100000,500000];

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '2m',  target: 200 },
    { duration: '30s', target: 0 }
  ]
};

export default function () {
  const body = JSON.stringify({
    amount: amounts[Math.floor(Math.random() * amounts.length)],
    method: methods[Math.floor(Math.random() * methods.length)]
  });
  const res = http.post('http://localhost:3000/api/payment', body,
    { headers: { 'Content-Type': 'application/json' } });
  check(res, { 'response received': (r) => r.status !== 0 });
}
```

## Scenarios for log analysis exercises

1. Baseline — start with `successRate: 0.92`, run 10 min of load, analyze error
   rate per method and per RC.
2. Degradation — flip `successRate` to `0.60` mid-run; detect the change from
   the log stream.
3. Upstream outage — set weight of RC `68` very high to simulate the bank
   being slow/unavailable; observe how `totalLatencyMs` distribution shifts.
4. Fraud spike — raise RC `05` weight; trace which `method` values are affected.

## Folder layout

```
sample-apps/payment-gateway/
├── config/default.json       # authoritative config, no silent defaults
├── logs/                     # runtime log output (gitignored)
├── package.json
├── README.md
└── src/
    ├── app.js                # express bootstrap
    ├── config.js             # strict config loader
    ├── logger.js             # pino multi-stream (file + stdout)
    ├── routes/payment.js     # HTTP routes
    └── services/
        ├── simulator.js      # rng + weighted pick + runtime tuning
        ├── bankConnector.js  # simulated upstream bank call
        └── paymentService.js # orchestrates txn id, logging, latency
```
