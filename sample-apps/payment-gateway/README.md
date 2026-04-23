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


## Build Docker Image

```bash
docker build -t payment-gateway-js .
```

### Build Multi-Arch 

Apabila build dilakukan di komputer Macbook dengan Apple Silicon atau Raspberry PI, image yang terbentuk akan berarsitektur `arm64`. Image ini tidak akan bisa dijalankan di prosesor Intel yang berarsitektur `amd64`.

Bila kita ingin membuat image berarsitektur `amd64`, maka kita perlu menggunakan utilitas `buildx`. 

1. Install dulu `buildx`nya

    ```
    docker buildx create --name multiarch-builder --driver docker-container --use
    ```

2. Cek apakah sudah terinstall

    ```
    docker buildx ls
    ```

    Pastikan `multiarch-builder` sudah terdaftar dan sudah menjadi default

    ```
    NAME/NODE                DRIVER/ENDPOINT    STATUS    BUILDKIT   PLATFORMS
    multiarch-builder*       docker-container                        
    \_ multiarch-builder0    \_ orbstack       running   v0.29.0    linux/amd64 (+2), linux/arm64, linux/arm (+2), linux/ppc64le, (4 more)
    default                  docker                                  
    \_ default               \_ default        running   v0.25.2    linux/amd64 (+2), linux/arm64, linux/arm (+2), linux/ppc64le, (4 more)
    orbstack                 docker                                  
    \_ orbstack              \_ orbstack       running   v0.25.2    linux/amd64 (+2), linux/arm64, linux/arm (+2), linux/ppc64le, (4 more)
    ```

3. Lakukan build sekaligus push

    ```
    docker buildx build --platform linux/amd64,linux/arm64 -t endymuhardin/payment-gateway-js:2026.04.02 -t endymuhardin/payment-gateway-js:latest --push .
    ```

## Run Docker Image

```bash
docker run -p 3000:3000 payment-gateway-js
```

## API

Ringkasan semua endpoint:

| Method | Path                                   | Kegunaan                                              |
|--------|----------------------------------------|-------------------------------------------------------|
| POST   | `/api/payment`                         | Proses transaksi (endpoint utama)                     |
| GET    | `/api/health`                          | Liveness — selalu UP                                  |
| GET    | `/api/admin/config`                    | Inspeksi state simulator                              |
| PUT    | `/api/admin/config/success-rate`       | Ubah success rate                                     |
| PUT    | `/api/admin/config/error-distribution` | Ubah komposisi error                                  |
| PUT    | `/api/admin/config/cpu`                | Aktif/non-aktifkan + tune CPU-intensive simulation    |
| PUT    | `/api/admin/config/memory`             | Aktif/non-aktifkan + tune memory retention simulation |
| POST   | `/api/admin/memory/clear`              | Lepaskan record yang ditahan                          |
| GET    | `/api/admin/metrics`                   | Metrik proses (rss, heap, cpu, retained count)        |

> Endpoint `/api/admin/*` **tidak diautentikasi**. Jangan expose ke luar
> lingkungan training. Di deployment Ansible, bind tetap di `0.0.0.0:3000`
> karena nginx yang di-depannya belum filter path admin — silakan tambahkan
> `location /api/admin/ { deny all; }` di nginx kalau ingin restriksi.

### `POST /api/payment`

Endpoint utama untuk memproses transaksi. Request akan dihitung dengan
RNG di simulator untuk menentukan outcome (success atau error RC), plus
latency sintetik dari bank connector.

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

HTTP `400` dibalas kalau request body tidak valid (amount bukan angka positif,
method tidak dikenal, customerId bukan string).

### `GET /api/health`

Liveness check. Tidak sentuh resource eksternal — hanya balik status proses.
Cocok untuk probe orchestrator (k8s `livenessProbe`, systemd, dll.).

Response `200`:
```json
{ "status": "UP", "pid": 14210, "uptimeSec": 3421 }
```

Catatan: app ini **tidak** punya endpoint readiness terpisah. Karena tidak
ada dependency eksternal (DB, cache, upstream real), liveness sekaligus jadi
readiness. Kalau nanti ditambah DB, bikin `/api/ready` terpisah yang ping DB.

### `GET /api/admin/config`

Kembalikan seluruh state simulator saat ini. Dipakai untuk debugging dan
cross-check dari load test script (`k6-stress.js` dan `k6-soak.js` cek
state di `setup()`).

Response `200`:
```json
{
  "successRate": 0.92,
  "errorDistribution": [ { "rc": "51", "weight": 35, ... }, ... ],
  "latencyMs": { "baseMin": 40, "baseMax": 180, "timeoutMin": 3000, "timeoutMax": 8000 },
  "methods": ["QRIS", "VA_BCA", ...],
  "cpu": { "enabled": false, "probability": 0.3, "hashRounds": 150000 },
  "memory": { "retainRecords": false, "maxRecords": 200000, "payloadKb": 8 }
}
```

### `PUT /api/admin/config/success-rate`

Ubah `simulation.successRate` secara runtime. Log line `warn` ditulis
`success rate changed at runtime` setiap kali dipanggil — supaya perubahan
terlihat di post-incident analysis log.

Request:
```json
{ "successRate": 0.80 }
```

Validasi: angka antara 0 dan 1 inklusif. Response `400` kalau di luar rentang.

Response `200`:
```json
{ "successRate": 0.80 }
```

### `PUT /api/admin/config/error-distribution`

Ganti seluruh pool error — entry lama di-replace (bukan di-merge). Dipakai
untuk simulasi upstream outage (weight RC 68 tinggi) atau fraud spike
(weight RC 05 tinggi).

Request:
```json
{
  "errorDistribution": [
    { "rc": "68", "weight": 70, "message": "Upstream Bank Timeout", "level": "error", "httpStatus": 504, "simulateTimeout": true },
    { "rc": "51", "weight": 30, "message": "Insufficient Funds", "level": "warn", "httpStatus": 402 }
  ]
}
```

Validasi setiap entry: `rc`, `weight`, `message`, `level`, `httpStatus` wajib; `weight > 0`; `level` ∈ {info, warn, error}. Response `400` kalau gagal validasi.

Response `200`: echo back `errorDistribution` baru.

### `PUT /api/admin/config/cpu`

Aktif/non-aktifkan + tune CPU-intensive fraud scoring (SHA-256 hashing
loop sinkron di event loop). Dipakai untuk demonstrasi saturasi CPU dan
event-loop lag di `k6-stress.js`.

Request (semua field opsional — yang tidak dikirim akan dipertahankan):
```json
{ "enabled": true, "probability": 0.4, "hashRounds": 200000 }
```

- `enabled`: boolean, saklar master
- `probability`: 0..1, fraksi request yang kena jalur CPU
- `hashRounds`: integer ≥ 0, jumlah iterasi SHA-256 per request yang terpicu

Response `200`: state `cpu` penuh setelah update.

### `PUT /api/admin/config/memory`

Aktif/non-aktifkan + tune retensi record di memory. Dipakai untuk
demonstrasi memory leak di `k6-soak.js`.

Request (semua field opsional):
```json
{ "retainRecords": true, "payloadKb": 16, "maxRecords": 500000 }
```

- `retainRecords`: boolean, saklar master
- `maxRecords`: integer > 0, batas aman agar tidak OOM
- `payloadKb`: integer ≥ 0, ukuran buffer dummy per record (untuk mempercepat growth RSS)

Response `200`: state `memory` penuh setelah update.

### `POST /api/admin/memory/clear`

Kosongkan `Map<txnId, record>` yang menahan record (recovery dari leak
sintetik). `retainRecords` flag **tidak** diubah — kalau masih `true`,
record baru langsung ditahan lagi.

Request: tidak ada body.

Response `200`:
```json
{ "dropped": 23013 }
```

Catatan: `retainedRecords` di `/api/admin/metrics` langsung jadi 0 setelah
call ini, tapi `rssMb` dan `arrayBuffersMb` baru turun setelah V8 GC berikutnya
(lazy, bisa beberapa detik hingga menit).

### `GET /api/admin/metrics`

Metrik proses real-time. Sumber primary untuk observasi memory/CPU saat
load test (dipakai `watch -n 5 'curl -s .../metrics | jq'`).

Response `200`:
```json
{
  "retainedRecords": 21377,
  "memoryUsage": {
    "rssMb": 300.78,
    "heapUsedMb": 29.81,
    "heapTotalMb": 52.3,
    "externalMb": 168.4,
    "arrayBuffersMb": 167.11
  },
  "cpuUsage": {
    "userMs": 489270.87,
    "systemMs": 10724.94
  },
  "uptimeSec": 9609
}
```

- `retainedRecords`: jumlah entry di `Map` retensi (jika `memory.retainRecords=true`)
- `memoryUsage.*`: hasil `process.memoryUsage()`, dikonversi ke MB
- `cpuUsage.userMs` / `.systemMs`: **kumulatif** CPU time sejak start (bukan %).
  Untuk dapat % 1 core: `delta_userMs / (interval_detik × 1000) × 100`. Penjelasan
  lengkap + contoh ada di [loadtest/CAPACITY.md](loadtest/CAPACITY.md#konversi-cpu-ms-).
- `uptimeSec`: proses uptime

Saat CPU simulation aktif dan event loop tersumbat, **endpoint ini juga bisa
timeout** — lihat section "Hasil observasi aktual → Stress" untuk contoh
(admin endpoint dead ~4.5 menit selama fase puncak stress).

### Cheat-sheet curl

```bash
# Inspeksi + metrik
curl http://localhost:3000/api/admin/config
curl http://localhost:3000/api/admin/metrics

# Ubah success rate
curl -X PUT http://localhost:3000/api/admin/config/success-rate \
  -H 'content-type: application/json' \
  -d '{"successRate": 0.80}'

# Aktifkan CPU-intensive
curl -X PUT http://localhost:3000/api/admin/config/cpu \
  -H 'content-type: application/json' \
  -d '{"enabled": true, "probability": 0.4, "hashRounds": 200000}'

# Aktifkan memory retention
curl -X PUT http://localhost:3000/api/admin/config/memory \
  -H 'content-type: application/json' \
  -d '{"retainRecords": true, "payloadKb": 16, "maxRecords": 500000}'

# Recovery memory
curl -X POST http://localhost:3000/api/admin/memory/clear

# Demo upstream outage (weight RC 68 tinggi)
curl -X PUT http://localhost:3000/api/admin/config/error-distribution \
  -H 'content-type: application/json' \
  -d '{"errorDistribution":[
        {"rc":"68","weight":70,"message":"Upstream Bank Timeout","level":"error","httpStatus":504,"simulateTimeout":true},
        {"rc":"51","weight":30,"message":"Insufficient Funds","level":"warn","httpStatus":402}
      ]}'
```

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

Ada empat script k6 di folder `loadtest/`. Masing-masing menyasar tujuan training
yang berbeda:

| Script                | Skenario                                                        | Yang diamati                                                   |
|-----------------------|-----------------------------------------------------------------|----------------------------------------------------------------|
| `k6-baseline.js`      | 4 menit, ramp ke 20 VU                                          | mengisi `logs/payment-app.log` dengan campuran RC untuk analisis |
| `k6-stress.js`        | 5 menit, ramp ke 300 VU, **simulasi CPU diaktifkan via setup**  | saturasi CPU, event-loop lag, tail latency                     |
| `k6-soak.js`          | 15 menit konstan 40 VU, **retensi memori diaktifkan via setup** | pertumbuhan RSS/heap, tekanan GC                               |
| `k6-capacity.js`      | constant-arrival-rate, parameterized (`RPS=… DURATION=…`)       | batas throughput + knee of the curve untuk capacity planning   |

Untuk `k6-capacity.js` (capacity planning), prosedur lengkap — ramp
multi-step, cara ekstraksi data per step, cara interpretasi, dan hasil
aktual dari server training — ada di dokumen terpisah:
[loadtest/CAPACITY.md](loadtest/CAPACITY.md).

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

### Menjalankan ke server (remote)

Semua script menerima env var `BASE_URL`. Kalau aplikasi sudah di-deploy lewat
Ansible, nginx meng-proxy `/api/*` ke `127.0.0.1:3000`, jadi cukup pakai port 80:

```bash
# ganti 10.0.120.6 dengan IP / hostname server training Anda
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-baseline.js
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-stress.js
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-soak.js
```

Sebelum menjalankan, pastikan:

- Laptop Anda punya route ke IP server (RFC1918 10.x.x.x biasanya hanya
  reachable lewat VPN — tes dulu dengan `curl http://<ip>/api/health`).
- Admin endpoint (`/api/admin/*`) terbuka dari laptop Anda. Script `k6-stress`
  dan `k6-soak` memanggil `PUT /api/admin/config/cpu` / `.../memory` di
  `setup()`; kalau IP Anda tidak di-allow oleh nginx / firewall, `setup()` akan
  gagal dan skenario CPU/memori tidak akan aktif walau traffic tetap jalan.
- Service sedang aktif: `ssh <user>@<ip> 'systemctl is-active payment-gateway'`.

Contoh run cepat (dari laptop → server `10.0.120.6`, 4 menit, 20 VU):

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

Untuk server remote, jalankan `top`/`ps` lewat ssh. **Catatan**: di fase
puncak stress test, admin endpoint `/api/admin/metrics` bisa ikut timeout
karena memakai event loop yang sama — polling lewat `ssh ... 'top -bn1'`
tetap jalan selama kernel OS masih punya slot CPU (ini pun bisa melambat
kalau kedua core sudah 100% seperti VM training).

### Memori (run soak)

Sementara `k6-soak.js` berjalan, polling endpoint metrics atau `ps`:

```bash
# view dari sisi aplikasi
watch -n 5 'curl -s http://localhost:3000/api/admin/metrics | jq'

# view dari sisi OS
watch -n 5 'ps -p $(pgrep -f "node src/app.js") -o pid,%mem,rss,vsz'
```

Ekspektasi (observasi nyata di server training 2-core / 7.5 GB RAM):

- Throughput ≈ 2.5 req/s per VU (iterasi ~330 ms, 0.2 s sleep). Jadi 30 VU →
  ~75 req/s, 40 VU → ~100 req/s.
- Retensi menangkap **semua** request (sukses + gagal) selama `retainRecords=true`,
  bukan hanya sukses.
- `payloadKb` menentukan kecepatan pertumbuhan: 8 KB × 75 req/s ≈ 36 MB/menit;
  16 KB × 100 req/s ≈ 96 MB/menit.
- `rssMb` tumbuh linier seiring `arrayBuffersMb` (buffer dummy di luar V8 heap).
  `heapUsedMb` relatif stabil karena V8 sering menggarbage-collect objek kecilnya.

Picu recovery di tengah run untuk melihat RSS turun:

```bash
curl -X POST http://localhost:3000/api/admin/memory/clear
```

`retainedRecords` langsung jadi 0 setelah clear, tapi `rssMb` dan
`arrayBuffersMb` tidak instant drop — V8 baru menyusutkan heap di siklus GC
berikutnya (detik–menit). Kalau butuh observasi cepat, trigger GC paksa
dengan `node --expose-gc` + `global.gc()` via admin endpoint (tidak default).

### Event-loop lag (bonus)

Event-loop lag adalah sinyal CPU paling jelas untuk Node. Pasang `clinic` sekali
saja untuk flamegraph, atau pakai profiler bawaan:

```bash
node --inspect src/app.js
# lalu buka chrome://inspect di Chrome dan attach profiler
```

## Analisis hasil load test

Setelah k6 selesai, Anda punya dua sumber data:

1. **Sisi klien (k6 summary)** — throughput, p95/p99, error rate dari perspektif
   user. Dipengaruhi network latency + antrian di server.
2. **Sisi server (log aplikasi)** — RC per transaksi, `bankLatencyMs`,
   `cpuBurnMs`, `totalLatencyMs`. Murni latency aplikasi, tidak terpengaruh
   network.

Korelasikan keduanya untuk memisahkan masalah jaringan vs masalah aplikasi.

### Lokasi log di server

Saat dideploy lewat Ansible:

| Path                                        | Isi                            |
|---------------------------------------------|--------------------------------|
| `/var/log/payment-gateway/payment-app.log`  | app log (JSON per baris), file-owned root |
| `journalctl -u payment-gateway`             | mirror stdout → systemd journal |

Contoh pengambilan log dari server ke laptop untuk dianalisis lokal:

```bash
ssh azureuser@10.0.120.6 'sudo cat /var/log/payment-gateway/payment-app.log' > /tmp/pg.log
wc -l /tmp/pg.log
```

Semua contoh `jq` di bawah mengasumsikan file `/tmp/pg.log`. Ganti dengan
`logs/payment-app.log` kalau Anda menjalankan app lokal, atau pipe langsung
dari `ssh ... 'sudo cat ...'`.

### Recipe jq

```bash
# Jumlah request per response code
jq -r 'select(.logger=="PaymentService" and .rc) | .rc' /tmp/pg.log \
  | sort | uniq -c | sort -rn

# Success rate observasi vs konfigurasi (harus dekat dengan simulation.successRate)
jq -r 'select(.logger=="PaymentService" and .rc) | .rc' /tmp/pg.log \
  | awk '{t++; if ($0=="00") s++} END {printf "success=%d/%d = %.2f%%\n", s, t, s*100/t}'

# Persentil latency total (p50 / p95 / p99 / max)
jq -r 'select(.logger=="PaymentService" and .totalLatencyMs) | .totalLatencyMs' /tmp/pg.log \
  | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END{
      printf "count=%d p50=%d p95=%d p99=%d max=%d\n",
        c, a[int(c*0.5)], a[int(c*0.95)], a[int(c*0.99)], a[c-1]}'

# Breakdown latency per RC (count, mean, p95) — cek apakah RC 68 muncul di ekor.
# Butuh `datamash` (brew install datamash / dnf install datamash).
jq -r 'select(.logger=="PaymentService" and .rc and .totalLatencyMs)
       | "\(.rc)\t\(.totalLatencyMs)"' /tmp/pg.log \
  | sort | datamash -g 1 count 2 mean 2 perc:95 2

# Error rate per method — deteksi kalau satu method (mis. CREDIT_CARD) lebih sering gagal
jq -r 'select(.logger=="PaymentService" and .status)
       | "\(.method) \(.status)"' /tmp/pg.log \
  | awk '{t[$1]++; if ($2!="SUCCESS") f[$1]++} END {
      for (m in t) printf "%-12s %5d req, %5d fail, %.1f%% fail rate\n", m, t[m], f[m]+0, (f[m]+0)*100/t[m]}' \
  | sort

# Jejak lengkap satu transaksi berdasarkan traceId (untuk incident postmortem)
jq -c 'select(.traceId=="bf9c67fceff5f40b")' /tmp/pg.log

# Jendela-waktu 1 menit — request per detik dari waktu ke waktu
jq -r 'select(.logger=="PaymentService" and .msg=="payment request received")
       | .time[0:19]' /tmp/pg.log \
  | sort | uniq -c | awk '{print $2, $1}'

# Hitung berapa request yang melewati jalur CPU-intensive (field cpuBurnMs > 0)
jq -r 'select(.logger=="PaymentService" and .cpuBurnMs and .cpuBurnMs > 0)
       | .cpuBurnMs' /tmp/pg.log | wc -l

# Mean / max cpuBurnMs (kalau k6-stress dijalankan)
jq -r 'select(.cpuBurnMs and .cpuBurnMs > 0) | .cpuBurnMs' /tmp/pg.log \
  | awk '{s+=$1; if ($1>m) m=$1} END {printf "n=%d mean=%.1f max=%d\n", NR, s/NR, m}'
```

### Korelasi k6 ↔ server

| Pertanyaan yang bagus                                              | Bandingkan                                                      |
|--------------------------------------------------------------------|-----------------------------------------------------------------|
| "Apakah error rate yang dilihat user sama dengan simulator?"        | k6 `http_req_failed` vs `jq` success-rate observasi             |
| "Apakah latency user tinggi karena network atau karena app?"        | k6 `http_req_duration` p95 vs app-log `totalLatencyMs` p95      |
| "Saat stress test, berapa ms CPU burn nyangkut di tail latency?"    | `cpuBurnMs` mean vs `totalLatencyMs - bankLatencyMs - cpuBurnMs` |
| "Saat soak test, seberapa cepat memori bocor?"                      | `/api/admin/metrics` `rssMb` polling 5s vs `retainedRecords`    |

### Hasil observasi aktual (server training 2-core / 7.5 GB / Node 22)

Angka-angka di bawah direkam saat validasi, untuk kalibrasi ekspektasi.

**Baseline — `k6 run loadtest/k6-baseline.js`** (4 menit, 20 VU max)

| Metrik                                | Nilai                                    |
|---------------------------------------|------------------------------------------|
| k6 throughput                         | 39.2 req/s (9422 iterations)             |
| k6 `http_req_duration` p50 / p95      | 131 ms / 200 ms                          |
| k6 `http_req_failed`                  | 7.77%                                    |
| App log `totalLatencyMs` p50 / p95 / p99 / max | 111 / 175 / 3930 / 7984 ms      |
| Success rate observasi                | 92.2% (8751/9491) — cocok dengan `successRate: 0.92` |
| Distribusi RC error (51/55/61/68/96/05) | 35/18/16/16/9/6% — cocok dengan bobot konfigurasi |

**Stress — `k6 run loadtest/k6-stress.js`** (5 min, 300 VU peak, CPU hashRounds=200000, probability=0.5)

| Metrik                                | Nilai                                    |
|---------------------------------------|------------------------------------------|
| k6 throughput                         | 7.27 req/s (anjlok dari 39 → 7 karena antrian) |
| k6 `http_req_duration` p50 / p95 / max | 27 s / 30 s / 30.12 s (threshold p95<5s DILANGGAR) |
| k6 `http_req_failed`                  | 44.96% — mayoritas 504 Gateway Timeout dari nginx |
| App log `totalLatencyMs` p50 / p95    | 353 / 528 ms (jauh lebih rendah dari k6) |
| `cpuBurnMs` mean / max                | 243 / 363 ms per request yang terpicu    |
| Total CPU time saat tes               | +380 s `process.cpuUsage().user` untuk 5 menit wall-clock |
| Admin endpoint (`/api/admin/*`)       | **Tidak responsif** selama ~4.5 menit — event loop tersumbat |
| SSH ke server                         | Juga timeout 3s selama fase puncak (kedua core di ~100%) |

*Catatan*: gap besar antara k6 p95 (30s) dan app-log p95 (528ms) adalah
**antrian di nginx/accept-queue**. Request menunggu 25–30 detik sebelum
event loop sempat menerimanya; setelah diterima, pemrosesan sendiri "hanya"
~500 ms. Ini pola khas saturasi event loop di Node.

**Soak — `BASE_URL=... SOAK_DURATION=5m SOAK_VUS=30 MEMORY_PAYLOAD_KB=8 k6 run loadtest/k6-soak.js`**

| Metrik                                | Nilai                                    |
|---------------------------------------|------------------------------------------|
| k6 throughput                         | 75.2 req/s (23013 iterations)            |
| k6 `http_req_duration` p50 / p95      | 129 / 194 ms — seperti baseline (tidak ada CPU burn) |
| `retainedRecords` growth              | ~76/s → 1273 @ 16s, 21377 @ 4 menit, 23013 total |
| `arrayBuffersMb` growth               | 10 MB → 167 MB (growth ~0.6 MB/s, = 76 rec × 8 KB) |
| `rssMb` growth                        | 145 MB → 301 MB (≈ selaras dengan arrayBuffers) |
| `heapUsedMb`                          | 13–30 MB (stabil — object record kecil di-GC reguler) |
| Post-teardown (`memory/clear`)        | retained=0 langsung, rss turun 301→277 MB (24 MB), arrayBuf 167→180 MB (belum GC) |

*Peringatan*: default di `k6-soak.js` adalah **15 menit × 40 VU × 16 KB payload**,
yang memproyeksikan ~3 GB retensi. VM training 7.5 GB tanpa swap bisa OOM.
Turunkan ke angka-angka di atas kalau batasan RAM ketat, atau monitor dengan
`watch free -h` paralel.

### Gotcha yang umum

- **Stress test teardown bisa gagal** — saat ramp-down, event loop mungkin masih
  sibuk memproses antrian CPU-burn yang tertahan. Call `PUT /admin/config/cpu`
  dari `teardown()` bisa balas 504 Gateway Timeout. Kalau Anda lihat k6
  mengeluh di fase akhir, verifikasi: `curl .../admin/config | jq .cpu` —
  kalau `enabled: true`, reset manual.
- **Log masih muncul setelah k6 selesai** — karena baseline `setup()`/
  `teardown()` tidak menyentuh admin API, tapi stress & soak iya. Kalau Anda
  men-`ctrl+c` k6 di tengah, `teardown()` tidak jalan — state CPU / memory
  retention tetap `enabled`. Reset manual: `curl -X PUT .../admin/config/cpu -d '{"enabled":false}'`.
- **jq lambat di log besar** — `jq` membaca satu objek per saat. Di log >1 GB,
  filter dulu dengan `grep -F '"PaymentService"'` sebelum `jq`, atau pakai
  `gojq`.
- **Clock skew** — `time` di log pakai UTC isoformat. Kalau korelasi dengan
  log nginx (yang mungkin pakai timezone lokal), konversi dulu. `date -u` di
  laptop membantu.
- **`ssh` saat stress** — kalau SSH sendiri timeout selama stress test, itu
  bukan bug jaringan: kedua core server sedang 100%, kernel pun lambat
  respons. Tunggu test selesai atau turunkan `CPU_HASH_ROUNDS`.

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
│   ├── CAPACITY.md           # procedure + hasil capacity planning
│   ├── k6-baseline.js        # traffic campuran yang stabil untuk mengisi log
│   ├── k6-stress.js          # ramp-up, mengaktifkan jalur CPU-intensive
│   ├── k6-soak.js            # jangka panjang, mengaktifkan retensi memori
│   └── k6-capacity.js        # constant-arrival-rate, parameterized per-run
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
