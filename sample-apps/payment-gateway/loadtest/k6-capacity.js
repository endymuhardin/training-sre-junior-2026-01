import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const RPS = Number(__ENV.RPS || '50');
const DURATION = __ENV.DURATION || '60s';
const WARMUP = __ENV.WARMUP || '10s';

const methods = ['QRIS', 'VA_BCA', 'VA_BSI', 'VA_MANDIRI', 'CREDIT_CARD', 'GOPAY', 'OVO'];
const amounts = [10000, 25000, 50000, 100000, 500000];

export const options = {
  scenarios: {
    capacity: {
      executor: 'constant-arrival-rate',
      rate: RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, RPS * 2),
      maxVUs: Math.max(200, RPS * 15),
      gracefulStop: '15s'
    }
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: true
};

function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}

export function setup() {
  // Pastikan CPU/memory simulation OFF — tes ini murni mengukur kapasitas
  // infrastruktur (event loop + nginx + simulasi bank connector).
  const cpuRes = http.put(`${BASE_URL}/api/admin/config/cpu`,
    JSON.stringify({ enabled: false }),
    { headers: { 'Content-Type': 'application/json' } });
  if (cpuRes.status !== 200) {
    throw new Error(`failed to disable CPU sim: ${cpuRes.status} ${cpuRes.body}`);
  }
  const memRes = http.put(`${BASE_URL}/api/admin/config/memory`,
    JSON.stringify({ retainRecords: false }),
    { headers: { 'Content-Type': 'application/json' } });
  if (memRes.status !== 200) {
    throw new Error(`failed to disable memory retention: ${memRes.status} ${memRes.body}`);
  }
  const clearRes = http.post(`${BASE_URL}/api/admin/memory/clear`);
  if (clearRes.status !== 200) {
    throw new Error(`failed to clear retained records: ${clearRes.status}`);
  }
  console.log(`capacity run: target=${RPS} rps, duration=${DURATION}`);
  return { rps: RPS };
}

export default function () {
  http.post(`${BASE_URL}/api/payment`,
    JSON.stringify({ amount: pick(amounts), method: pick(methods) }),
    { headers: { 'Content-Type': 'application/json' } });
}
