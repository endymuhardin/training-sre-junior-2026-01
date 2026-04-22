# Sampel hasil load test — bahan latihan analisis

Isi folder ini adalah artefak real dari menjalankan script `loadtest/*.js`
ke server training (Azure VM 2-core / 7.5 GB / Node 22 LTS, nginx → Node).
Dipakai untuk latihan analisis log tanpa perlu setup ulang.

Semua file di sini **sudah di-strip** dari derau (progress tick k6, warning
"Request Failed" berulang, entry log yang tidak informatif) supaya tetap
ringan tapi masih representatif. Untuk referensi format lengkap, jalankan
sendiri scriptnya.

## Struktur

```
logs/samples/
├── baseline/
│   ├── k6-baseline.out          # k6 summary (39 RPS, 4 menit, 20 VU)
│   └── payment-app.sample.log   # ~280 baris sampel log app
├── stress/
│   ├── k6-stress.out            # k6 summary (300 VU peak, CPU sim ON)
│   ├── metrics-polling.log      # /api/admin/metrics polled per 5 detik
│   └── payment-app.sample.log   # ~225 baris, fokus cpuBurnMs + RC 68
├── soak/
│   ├── k6-soak.out              # k6 summary (30 VU, 5m, memory retention)
│   ├── metrics-polling.log      # polling per 10 detik, ada kurva tumbuh RSS
│   └── payment-app.sample.log   # record dengan retained=true, per-RC sample
└── capacity/
    ├── k6-{25,50,100,200,400,800,1600,2400}.out    # per-step k6 summary
    └── metrics-{before,after}-*.json               # /metrics snapshot per step
```

## Ringkasan angka (untuk cross-check hasil Anda)

Detail lengkap + interpretasi ada di `../CAPACITY.md` dan di README utama
(`../../README.md` → section "Hasil observasi aktual").

| Test         | k6 p50 | k6 p95 | fail % | RPS delivered | Catatan                        |
|--------------|-------:|-------:|-------:|--------------:|--------------------------------|
| baseline     | 131 ms | 200 ms |  7.77% |         39.2  | traffic normal, no-sim          |
| stress       |  27 s  |  30 s  | 44.96% |          7.3  | CPU saturasi, antrian nginx     |
| soak         | 129 ms | 194 ms |  7.89% |         75.2  | retensi memori 10→167 MB        |
| capacity 800 | 128 ms | 194 ms |  8.05% |        710.4  | **SLO-safe max**                |
| capacity 1600| 483 ms | 1.58 s | 23.63% |       1 365.9 | knee of curve                   |
| capacity 2400| 419 ms | 1.54 s | 51.45% |       1 909.5 | collapse (nginx 504 massive)    |

## Ide latihan (untuk peserta)

### Level 1 — baca format

1. Buka `baseline/payment-app.sample.log`. Identifikasi field yang ada di
   tiap record: `level`, `time`, `logger`, `traceId`, `txnId`, `method`,
   `rc`, `totalLatencyMs`.
2. Mana yang dihitung oleh simulator (bank connector) dan mana yang
   dihitung end-to-end di aplikasi? (hint: `bankLatencyMs` vs `totalLatencyMs`)

### Level 2 — jq dasar

Semua resep ada di README utama. Jalankan di sampel:

```bash
# Hitung per-RC di baseline
jq -r 'select(.logger=="PaymentService" and .rc) | .rc' \
  baseline/payment-app.sample.log | sort | uniq -c

# Latency p50/p95/p99 di soak
jq -r 'select(.totalLatencyMs) | .totalLatencyMs' \
  soak/payment-app.sample.log | sort -n | awk '...'
```

### Level 3 — deteksi fitur tidak normal

1. Di `stress/payment-app.sample.log`, temukan record pertama yang menunjukkan
   jalur CPU-intensive terpicu (field `cpuBurnMs > 0`). Berapa `cpuBurnMs`
   rata-rata di sampel?
2. Di `soak/payment-app.sample.log`, field apa yang muncul yang TIDAK ada
   di `baseline/`? (hint: `retained: true`)
3. Dari `stress/metrics-polling.log`, di detik ke berapa admin endpoint
   mulai tidak respons? Berapa lama total `ERR`-nya?

### Level 4 — capacity planning

1. Buka semua 8 file `capacity/k6-*.out`. Bangun tabel: RPS target vs
   RPS delivered vs p95. Di mana knee-nya?
2. Dari `capacity/metrics-before-*.json` dan `-after-*.json`, hitung
   `cpuUsage.userMs` delta per step. Berapa ms CPU / request rata-rata?
   Dari sini, ekstrapolasikan batas saturasi 1 core.
3. Bandingkan k6 `http_req_duration` p95 dengan server-side `totalLatencyMs`
   (dari sampel log di stress/soak). Mengapa k6 angkanya lebih besar saat
   saturasi?

### Level 5 — korelasi

Di `stress/metrics-polling.log`, waktu saat `rssMb` loncat bersamaan dengan
`cpuUsage.userMs` naik drastis adalah tanda kapan CPU-intensive path aktif.
Cocokkan dengan timestamp di `k6-stress.out` (fase `setup()` dan `teardown()`).

## Regenerasi sampel

File-file ini **tidak** auto-generated dari CI. Kalau knob di aplikasi
berubah (mis. pindah ke Node 24, tambah field log, ubah weight error), regen
manual:

```bash
cd sample-apps/payment-gateway

# baseline (~4 min)
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-baseline.js

# stress (~5 min)
BASE_URL=http://10.0.120.6 k6 run loadtest/k6-stress.js

# soak (~5 min, tuned)
BASE_URL=http://10.0.120.6 SOAK_DURATION=5m SOAK_VUS=30 MEMORY_PAYLOAD_KB=8 \
  k6 run loadtest/k6-soak.js

# capacity ramp (~10 min) — lihat ../CAPACITY.md untuk shell loop
```

Lalu sample ulang log server + k6 summary dengan langkah yang sama seperti
yang dipakai untuk membangun folder ini (script sampling belum dikodifikasi).
