import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const methods = ['QRIS', 'VA_BCA', 'VA_BSI', 'VA_MANDIRI', 'CREDIT_CARD', 'GOPAY', 'OVO'];
const amounts = [10000, 25000, 50000, 100000, 250000, 500000, 1000000];
const customers = ['cust-001', 'cust-002', 'cust-003', 'cust-004', 'cust-005'];

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '3m',  target: 20 },
        { duration: '30s', target: 0 }
      ],
      gracefulRampDown: '10s'
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.15']
  }
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const body = JSON.stringify({
    amount: pick(amounts),
    method: pick(methods),
    customerId: pick(customers)
  });
  const res = http.post(`${BASE_URL}/api/payment`, body, {
    headers: { 'Content-Type': 'application/json' },
    tags: { endpoint: 'payment' }
  });
  check(res, {
    'response received': (r) => r.status !== 0,
    'known status': (r) => [200, 401, 402, 403, 429, 500, 504].includes(r.status)
  });
  sleep(Math.random() * 0.5);
}
