import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const methods = ['QRIS', 'VA_BCA', 'VA_BSI', 'VA_MANDIRI', 'CREDIT_CARD', 'GOPAY', 'OVO'];
const amounts = [10000, 25000, 50000, 100000, 500000];

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m',  target: 150 },
        { duration: '2m',  target: 300 },
        { duration: '1m',  target: 300 },
        { duration: '30s', target: 0 }
      ],
      gracefulRampDown: '10s'
    }
  },
  thresholds: {
    http_req_duration: ['p(95)<5000']
  }
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function setup() {
  const cpuBody = JSON.stringify({
    enabled: true,
    probability: Number(__ENV.CPU_PROBABILITY || '0.5'),
    hashRounds: Number(__ENV.CPU_HASH_ROUNDS || '200000')
  });
  const res = http.put(`${BASE_URL}/api/admin/config/cpu`, cpuBody, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (res.status !== 200) {
    throw new Error(`failed to enable CPU simulation: ${res.status} ${res.body}`);
  }
  console.log(`CPU simulation enabled: ${res.body}`);
  return { cpuEnabled: true };
}

export function teardown() {
  const res = http.put(`${BASE_URL}/api/admin/config/cpu`, JSON.stringify({ enabled: false }), {
    headers: { 'Content-Type': 'application/json' }
  });
  console.log(`CPU simulation restored: ${res.body}`);
}

export default function () {
  const body = JSON.stringify({
    amount: pick(amounts),
    method: pick(methods)
  });
  const res = http.post(`${BASE_URL}/api/payment`, body, {
    headers: { 'Content-Type': 'application/json' }
  });
  check(res, {
    'response received': (r) => r.status !== 0
  });
  sleep(0.1);
}
