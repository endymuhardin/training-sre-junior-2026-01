# Payment Gateway Simulator

Aplikasi Express.js yang mensimulasikan API payment gateway. Dirancang untuk
dihantam oleh tools load testing dan menghasilkan log JSON-structured untuk
dianalisis belakangan.

## Stack

- Node.js >= 18
- [express](https://expressjs.com/) — framework HTTP
- [pino](https://getpino.io/) + [pino-http](https://github.com/pinojs/pino-http) — structured JSON logging (padanan logback di ekosistem Node.js)

## Instal & Jalankan

```bash
cd sample-apps/payment-gateway
npm install
npm start
```

Server bind ke `0.0.0.0:3000` secara default. Log ditulis ke:

- `logs/payment-app.log` — log aplikasi (JSON per baris)
- stdout — record yang sama, untuk `docker logs` / `journalctl`

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

- `amount`: angka positif (IDR, disarankan integer)
- `method`: salah satu dari `QRIS`, `VA_BCA`, `VA_BSI`, `VA_MANDIRI`, `CREDIT_CARD`, `GOPAY`, `OVO`
- `customerId`: string, opsional

Response (HTTP status mengikuti hasil — `200`, `401`, `402`, `403`, `429`, `500`, `504`):
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

Liveness check. Selalu mengembalikan `200` berisi pid dan uptime.

### Admin (tuning saat runtime)

```bash
# lihat state simulator sekarang (success rate, error, cpu, memory)
curl http://localhost:3000/api/admin/config

# metrik proses + retained records (rss, heap, cpu usage)
curl http://localhost:3000/api/admin/metrics

# ubah success rate
curl -X PUT http://localhost:3000/api/admin/config/success-rate \
  -H 'content-type: application/json' \
  -d '{"successRate": 0.80}'

# ganti distribusi error
curl -X PUT http://localhost:3000/api/admin/config/error-distribution \
  -H 'content-type: application/json' \
  -d '{"errorDistribution":[
        {"rc":"68","weight":70,"message":"Upstream Bank Timeout","level":"error","httpStatus":504,"simulateTimeout":true},
        {"rc":"51","weight":30,"message":"Insufficient Funds","level":"warn","httpStatus":402}
      ]}'

# aktifkan fraud scoring CPU-intensive (loop hashing SHA-256 per request)
curl -X PUT http://localhost:3000/api/admin/config/cpu \
  -H 'content-type: application/json' \
  -d '{"enabled": true, "probability": 0.4, "hashRounds": 200000}'

# aktifkan retensi memori (tiap transaksi yang diproses ditahan di RAM dengan payload buffer)
curl -X PUT http://localhost:3000/api/admin/config/memory \
  -H 'content-type: application/json' \
  -d '{"retainRecords": true, "payloadKb": 16, "maxRecords": 500000}'

# lepaskan record yang ditahan (demo recovery)
curl -X POST http://localhost:3000/api/admin/memory/clear
```

> Endpoint admin tidak diautentikasi — jangan expose ke luar lingkungan training.

## Tuning

Semua knob berada di `config/default.json`. Sebagian dapat di-override lewat env var:

| Env var             | Config key                   | Keterangan                     |
|---------------------|------------------------------|--------------------------------|
| `PG_CONFIG_PATH`    | path file JSON config        | default: `config/default.json` |
| `PG_PORT`           | `server.port`                | integer 1..65535               |
| `PG_HOST`           | `server.host`                |                                |
| `PG_SUCCESS_RATE`   | `simulation.successRate`     | float 0..1                     |
| `PG_APP_LOG`        | `logging.appLogPath`         |                                |
| `PG_ACCESS_LOG`     | `logging.accessLogPath`      |                                |

Loader akan melempar error jika ada key wajib yang hilang atau tidak valid —
tidak ada silent defaults.

### Distribusi error

Tiap entry mendefinisikan:

- `rc` — response code yang ditulis ke log record
- `weight` — bobot probabilitas relatif dalam pool error
- `message` — alasan berupa teks
- `level` — `info` | `warn` | `error` (menentukan pino log level)
- `httpStatus` — HTTP status yang dikembalikan ke pemanggil
- `simulateTimeout` — jika `true`, pakai rentang `latencyMs.timeoutMin..timeoutMax` alih-alih rentang normal

Pool default (ubah di `config/default.json` atau lewat endpoint admin):

| RC | Message                           | Level | HTTP | Timeout? |
|----|-----------------------------------|-------|------|----------|
| 51 | Insufficient Funds                | warn  | 402  |          |
| 55 | Invalid PIN / OTP                 | warn  | 401  |          |
| 61 | Daily Velocity Limit Exceeded     | warn  | 429  |          |
| 68 | Upstream Bank Timeout             | error | 504  | ya       |
| 96 | System Malfunction ISO-8583       | error | 500  |          |
| 05 | Do Not Honor (Suspected Fraud)    | error | 403  |          |

### Simulasi latency

`simulation.latencyMs` mengontrol delay artifisial di dalam bank connector:

- `baseMin` / `baseMax` — operasi normal (baik sukses maupun error non-timeout)
- `timeoutMin` / `timeoutMax` — dipakai saat entry error punya `simulateTimeout: true`

### Simulasi CPU-intensive

`simulation.cpu` meniru langkah fraud-scoring yang mahal, dijalankan secara
sinkron di event loop Node.js sebelum panggilan ke bank. Saat dipicu, thread
request akan terblokir menghitung `hashRounds` iterasi SHA-256 — membakar
CPU dan menaikkan latency per-request.

| Key           | Tipe    | Arti                                                                   |
|---------------|---------|------------------------------------------------------------------------|
| `enabled`     | bool    | saklar utama                                                           |
| `probability` | 0..1    | fraksi request yang kena jalur CPU (mis. `0.3` = 30% traffic)          |
| `hashRounds`  | integer | iterasi SHA-256 per request yang terpicu; makin besar = CPU makin panas |

Tiap request yang terpicu akan menulis log `warn` `cpu-intensive fraud scoring executed`
berisi `cpuBurnMs` dan `hashRounds`, dan nilai `cpuBurnMs` juga ikut tercatat
di record payment utama.

### Simulasi memory-intensive

`simulation.memory` meniru cache bocor di dalam proses: setiap transaksi yang
diproses ditahan di `Map<txnId, { record, payload }>` bersama sebuah buffer
berukuran `payloadKb`. RSS akan tumbuh linier seiring traffic sampai batas
`maxRecords` tercapai (setelah itu retensi berhenti diam-diam — record yang
sudah di memori tetap di sana).

| Key             | Tipe    | Arti                                                     |
|-----------------|---------|----------------------------------------------------------|
| `retainRecords` | bool    | saklar utama                                             |
| `maxRecords`    | integer | batas aman supaya proses tidak OOM di host               |
| `payloadKb`     | integer | ukuran buffer dummy yang menempel di setiap record       |

Panggil `POST /api/admin/memory/clear` untuk melepas semuanya dan mengamati RSS turun.

## Format log

Pino mengeluarkan satu objek JSON per baris. Contoh (diformat supaya mudah dibaca):

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

Level numerik pino: `trace=10`, `debug=20`, `info=30`, `warn=40`, `error=50`, `fatal=60`.

Parse log dengan `jq`:

```bash
# hitungan per response code
jq -r 'select(.logger=="PaymentService") | .rc' logs/payment-app.log | sort | uniq -c

# p95 total latency
jq -r 'select(.logger=="PaymentService" and .totalLatencyMs) | .totalLatencyMs' \
  logs/payment-app.log | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END{print a[int(c*0.95)]}'

# hanya transaksi gagal
jq -c 'select(.status=="FAILED")' logs/payment-app.log
```

## Stress testing dengan k6

Ada tiga script k6 di folder `loadtest/`. Masing-masing menyasar tujuan training
yang berbeda:

| Script                | Skenario                                                        | Yang diamati                                                   |
|-----------------------|-----------------------------------------------------------------|----------------------------------------------------------------|
| `k6-baseline.js`      | 4 menit, ramp ke 20 VU                                          | mengisi `logs/payment-app.log` dengan campuran RC untuk analisis |
| `k6-stress.js`        | 5 menit, ramp ke 300 VU, **simulasi CPU diaktifkan via setup**  | saturasi CPU, event-loop lag, tail latency                     |
| `k6-soak.js`          | 15 menit konstan 40 VU, **retensi memori diaktifkan via setup** | pertumbuhan RSS/heap, tekanan GC                               |

### Instal k6

- macOS: `brew install k6`
- Linux (Debian/Ubuntu): [petunjuk repo resmi](https://grafana.com/docs/k6/latest/set-up/install-k6/#debian-ubuntu)
- Container: `docker run --rm -i --network host grafana/k6 run - < loadtest/k6-baseline.js`

### Cara menjalankan

```bash
cd sample-apps/payment-gateway

# terminal 1 — jalankan aplikasi
npm start

# terminal 2 — pilih salah satu:
k6 run loadtest/k6-baseline.js
k6 run loadtest/k6-stress.js
k6 run loadtest/k6-soak.js
```

Override target URL saat menghantam server remote:

```bash
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-baseline.js
```

### Knob tuning (environment variable)

```bash
# k6-stress.js — seberapa keras menekan CPU
CPU_PROBABILITY=0.8 CPU_HASH_ROUNDS=500000 k6 run loadtest/k6-stress.js

# k6-soak.js — seberapa cepat memori tumbuh dan berapa lama
MEMORY_PAYLOAD_KB=32 SOAK_VUS=80 SOAK_DURATION=30m k6 run loadtest/k6-soak.js
```

Fungsi `setup()` di masing-masing script memodifikasi simulator lewat API admin
sebelum traffic mulai; `teardown()` mereset knob setelah run selesai supaya
state proses kembali bersih untuk skenario berikutnya.

## Mengamati CPU dan memori

### CPU (run stress)

Sementara `k6-stress.js` berjalan, pantau proses Node dari terminal lain:

```bash
# macOS / Linux — kolom %CPU live
top -pid $(pgrep -f 'node src/app.js')          # macOS
top -p   $(pgrep -f 'node src/app.js')          # Linux
htop -p  $(pgrep -f 'node src/app.js')          # kalau htop terpasang

# snapshot sekali jalan
ps -p $(pgrep -f 'node src/app.js') -o pid,%cpu,%mem,rss,vsz,command
```

Ekspektasi: %CPU naik hingga ~100% dari satu core (JS di Node itu single-threaded).
Latency request meningkat karena `burnCpu()` memblokir event loop; field
`cpuBurnMs` di log record menunjukkan berapa ms yang dihabiskan murni untuk hashing.

### Memori (run soak)

Sementara `k6-soak.js` berjalan, polling endpoint metrics atau `ps`:

```bash
# view dari sisi aplikasi
watch -n 5 'curl -s http://localhost:3000/api/admin/metrics | jq'

# view dari sisi OS
watch -n 5 'ps -p $(pgrep -f "node src/app.js") -o pid,%mem,rss,vsz'
```

Ekspektasi: `retainedRecords` tumbuh ~40-60/detik (40 VU × ~5 req/detik per VU,
semuanya ditangkap selama retensi aktif). `rssMb` dan `heapUsedMb` tumbuh
linier. Picu recovery di tengah run untuk melihat RSS turun:

```bash
curl -X POST http://localhost:3000/api/admin/memory/clear
```

### Event-loop lag (bonus)

Event-loop lag adalah sinyal CPU paling jelas untuk Node. Pasang `clinic` sekali
saja untuk flamegraph, atau pakai profiler bawaan:

```bash
node --inspect src/app.js
# lalu buka chrome://inspect di Chrome dan attach profiler
```

## Skenario latihan analisis log

1. **Baseline** — `k6 run loadtest/k6-baseline.js`. Analisis error rate per
   method dan per RC dari `logs/payment-app.log`.
2. **Degradasi** — saat baseline sedang jalan, `PUT /api/admin/config/success-rate`
   ke `0.60`. Deteksi perubahan tersebut dari stream log.
3. **Upstream down** — `PUT /api/admin/config/error-distribution` dengan bobot
   besar di RC `68`. Amati bagaimana distribusi `totalLatencyMs` bergeser.
4. **Lonjakan fraud** — naikkan bobot RC `05`; telusuri nilai `method` mana
   yang terdampak.
5. **Saturasi CPU** — `k6 run loadtest/k6-stress.js`. Korelasikan `%CPU` OS,
   `p(95)` latency dari k6, dan field `cpuBurnMs` di log.
6. **Memory leak** — `k6 run loadtest/k6-soak.js`. Pantau RSS tumbuh sampai
   kamu panggil `/api/admin/memory/clear`, lalu lihat ia turun pada siklus GC
   berikutnya.

## Struktur folder

```
sample-apps/payment-gateway/
├── config/default.json       # config otoritatif, tidak ada silent defaults
├── logs/                     # output log saat runtime (gitignored)
├── loadtest/
│   ├── k6-baseline.js        # traffic campuran yang stabil untuk mengisi log
│   ├── k6-stress.js          # ramp-up, mengaktifkan jalur CPU-intensive
│   └── k6-soak.js            # jangka panjang, mengaktifkan retensi memori
├── package.json
├── README.md
└── src/
    ├── app.js                # bootstrap express
    ├── config.js             # config loader dengan validasi ketat
    ├── logger.js             # pino multi-stream (file + stdout)
    ├── routes/payment.js     # route HTTP + admin (cpu, memory, metrics)
    └── services/
        ├── simulator.js      # rng, cpu burn, retensi memori, metrics
        ├── bankConnector.js  # panggilan upstream bank yang disimulasikan
        └── paymentService.js # orkestrasi txn id, logging, latency
```
