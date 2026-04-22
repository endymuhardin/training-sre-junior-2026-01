import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const DURATION = __ENV.SOAK_DURATION || '15m';
const VUS = Number(__ENV.SOAK_VUS || '40');
const PAYLOAD_KB = Number(__ENV.MEMORY_PAYLOAD_KB || '16');
const MAX_RECORDS = Number(__ENV.MEMORY_MAX_RECORDS || '500000');

const methods = ['QRIS', 'VA_BCA', 'VA_BSI', 'VA_MANDIRI', 'CREDIT_CARD', 'GOPAY', 'OVO'];
const amounts = [10000, 25000, 50000, 100000, 500000];

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION
    }
  }
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function setup() {
  const body = JSON.stringify({
    retainRecords: true,
    maxRecords: MAX_RECORDS,
    payloadKb: PAYLOAD_KB
  });
  const res = http.put(`${BASE_URL}/api/admin/config/memory`, body, {
    headers: { 'Content-Type': 'application/json' }
  });
  if (res.status !== 200) {
    throw new Error(`failed to enable memory retention: ${res.status} ${res.body}`);
  }
  console.log(`memory retention enabled: ${res.body}`);
}

export function teardown() {
  const offRes = http.put(`${BASE_URL}/api/admin/config/memory`, JSON.stringify({ retainRecords: false }), {
    headers: { 'Content-Type': 'application/json' }
  });
  console.log(`memory retention disabled: ${offRes.body}`);
  const clearRes = http.post(`${BASE_URL}/api/admin/memory/clear`);
  console.log(`retained records cleared: ${clearRes.body}`);
}

export default function () {
  const body = JSON.stringify({
    amount: pick(amounts),
    method: pick(methods)
  });
  http.post(`${BASE_URL}/api/payment`, body, {
    headers: { 'Content-Type': 'application/json' }
  });
  sleep(0.2);
}
