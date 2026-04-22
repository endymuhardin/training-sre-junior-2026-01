# Capacity Planning — Payment Gateway Simulator

Dokumen ini menjelaskan prosedur mengukur kapasitas aplikasi secara
empiris: berapa RPS maksimum yang bisa ditangani sebelum latency dan error
rate keluar dari batas SLO. Juga berisi hasil pengukuran aktual di server
training.

## Kenapa capacity planning penting

Tanpa data, Anda tidak tahu:

- Berapa RPS maksimum sebelum sistem mulai drop?
- Di titik mana latency (p95/p99) mulai melewati SLO?
- Apakah bottleneck di CPU, event loop, koneksi upstream, atau memori?
- Seberapa banyak headroom yang tersisa di traffic saat ini?

Kapasitas bukan angka tetap — bergantung pada hardware, konfigurasi, versi,
dan workload mix. Cara paling jujur menjawab: **ukur**, dengan beban yang
mewakili produksi.

## Prinsip yang dipakai

### 1. Gunakan arrival-rate, bukan VU-count

Load test berbasis "jumlah VU" (virtual user) punya cacat: kalau server
melambat, VU tertahan di iterasi lama dan throughput aktual malah ikut turun
— Anda tidak tahu batas beban sebenarnya.

k6 executor `constant-arrival-rate` mengirim RPS tetap, apa pun yang
dilakukan server. Saat server kewalahan, k6 mencatat `dropped_iterations`
(tidak cukup VU) dan response time melejit — dua sinyal yang jelas.

### 2. Knee of the curve

Plot p95 latency vs RPS. Di beban rendah, p95 stabil. Ada satu titik — si
"knee" — di mana p95 mulai naik tajam. Itu adalah kapasitas praktis.
Beroperasi di atas knee = risiko incident.

```
  p95
   |         _______
   |        /
   |      /   ← knee (batas aman)
   |     /
   | ___/
   |____________________ RPS
```

### 3. Little's Law

`L = λ × W` di mana:

- L = jumlah request yang sedang diproses (concurrency)
- λ = arrival rate (RPS)
- W = response time rata-rata

Dipakai untuk: (a) menghitung VU yang dibutuhkan k6 sisi klien, (b)
mengestimasi berapa koneksi paralel yang harus didukung server.

Contoh: 500 RPS × 200 ms = 100 concurrent requests. Kalau nginx
`worker_connections` cuma 256, Anda akan kena bottleneck jauh sebelum
CPU saturasi.

### 4. SLO-driven, bukan 100%-CPU-driven

Kapasitas "100% sampai CPU pecah" tidak berguna untuk produksi. Yang
dipakai adalah kapasitas SLO-safe:

- SLO contoh: p95 < 500 ms, error rate < 2% (diluar error bisnis expected)
- Kapasitas = RPS maksimum di mana kedua angka itu masih dipenuhi
- Lalu beroperasi di 60–70% kapasitas itu (headroom 30–40%)

## Prosedur eksekusi

### Script

File: `loadtest/k6-capacity.js` — constant-arrival-rate executor,
parameterized. `setup()` memaksa CPU simulation OFF dan memory retention
OFF supaya tes ini benar-benar mengukur kapasitas infrastruktur, bukan
tertular state test sebelumnya.

### Jalankan satu step

```bash
cd sample-apps/payment-gateway

# 100 RPS selama 1 menit, ke server remote
BASE_URL=http://10.0.120.6 RPS=100 DURATION=60s k6 run loadtest/k6-capacity.js
```

### Jalankan ramp lengkap (recommended)

Pola umum: mulai dari beban jauh di bawah kapasitas dugaan, naik bertahap
sampai terlihat knee.

```bash
BASE_URL=http://10.0.120.6
mkdir -p /tmp/capacity-results

for RPS in 25 50 100 200 400 800 1600 2400; do
  echo "=== $RPS RPS ==="
  curl -sf --max-time 5 "$BASE_URL/api/admin/metrics" \
    > /tmp/capacity-results/metrics-before-$RPS.json

  BASE_URL="$BASE_URL" RPS="$RPS" DURATION=60s \
    k6 run loadtest/k6-capacity.js \
    > /tmp/capacity-results/k6-$RPS.out 2>&1

  curl -sf --max-time 5 "$BASE_URL/api/admin/metrics" \
    > /tmp/capacity-results/metrics-after-$RPS.json

  sleep 10   # settle between steps
done
```

Tips:

- **Durasi per step**: 60 s cukup untuk p95 stabil di beban rendah.
  Kalau latency volatile, perpanjang ke 2–3 menit.
- **Gap antar step**: minimal 10 s supaya koneksi TCP sebelumnya di-close
  dan nginx/Node bisa GC.
- **Pre-alokasi VU** di script sudah `max(50, RPS × 2)` dengan cap `RPS × 15`.
  Tidak perlu tuning kecuali Anda lihat `dropped_iterations` > 0.

### Ekstraksi data per step

Snippet di bawah berjalan baik di hasil run sendiri (di `/tmp/capacity-results/`)
**maupun** di sampel committed (`logs/samples/capacity/`) — ubah `DIR` ke yang
sesuai.

```bash
DIR=${DIR:-logs/samples/capacity}   # atau /tmp/capacity-results untuk run sendiri

echo "step,actual_rps,p50,p95,p99,fail_pct,cpu_delta_ms"
for rps in 25 50 100 200 400 800 1600 2400; do
  f=$DIR/k6-$rps.out
  actual=$(grep 'http_reqs' $f | grep -oE '[0-9.]+/s' | head -1 | tr -d /s)
  p50=$(grep 'http_req_duration' $f | grep -oE 'p\(50\)=[^ ]+' | head -1 | cut -d= -f2)
  p95=$(grep 'http_req_duration' $f | grep -oE 'p\(95\)=[^ ]+' | head -1 | cut -d= -f2)
  p99=$(grep 'http_req_duration' $f | grep -oE 'p\(99\)=[^ ]+' | head -1 | cut -d= -f2)
  fail=$(grep 'http_req_failed' $f | grep -oE '[0-9.]+%' | head -1 | tr -d %)
  cpu_b=$(jq -r '.cpuUsage.userMs' $DIR/metrics-before-$rps.json)
  cpu_a=$(jq -r '.cpuUsage.userMs' $DIR/metrics-after-$rps.json)
  cpu_delta=$(awk -v a=$cpu_a -v b=$cpu_b 'BEGIN{printf "%.0f", a-b}')
  echo "$rps,$actual,$p50,$p95,$p99,$fail,$cpu_delta"
done
```

Output dari snippet ini saat dijalankan di `logs/samples/capacity/` harus
**identik** dengan tabel di section "Hasil aktual" di bawah — kalau tidak,
ada yang error di parse Anda.

## Cara menganalisa

Untuk tiap RPS, jawab:

1. **Apakah latency masih dalam SLO?** p95 di bawah target (mis. 500 ms).
2. **Apakah error rate hanya dari business (simulated RC), bukan infra?**
   Business error = 8% default (dari `successRate: 0.92`). Kalau total
   error > 8%, selisihnya adalah infra (504 Gateway Timeout, connection
   refused, dll.).
3. **Apakah server masih responsive di sisi lain?** `/api/admin/metrics`
   seharusnya balik < 100 ms. Kalau timeout = event loop tersumbat.
4. **CPU saturasi?** `cpuUsage.userMs` yang naik > 1000 ms per detik
   (per core) = 100% satu core terpakai. Node single-threaded untuk JS,
   jadi batas ini cepat tercapai di workload CPU-intensive.
5. **Memory drift?** `rssMb` stabil = sehat. Kalau naik tanpa batas di
   beban konstan = leak.

Tandai titik di mana SALAH SATU jawaban mulai "tidak". Itu knee-nya.

## Hasil aktual — server training (Azure VM 2-core / 7.5 GB / Node 22 LTS)

**Config saat tes**: `successRate=0.92`, latency base 40–180 ms, RC 68
timeout 3–8 s, CPU sim + memory retention OFF. Client: k6 v1.7 dari
laptop lewat VPN → nginx → Node.

Setiap step = 60 s arrival rate, 10 s settle di antara.

### Artefak mentah (committed untuk latihan)

Semua angka di tabel di bawah bisa diregenerasi dari file-file berikut
(semua di `../logs/samples/capacity/`):

| Step      | k6 summary                                          | metrics before                                          | metrics after                                          |
|-----------|-----------------------------------------------------|---------------------------------------------------------|--------------------------------------------------------|
| 25 RPS    | [`k6-25.out`](../logs/samples/capacity/k6-25.out)   | [`metrics-before-25.json`](../logs/samples/capacity/metrics-before-25.json)     | [`metrics-after-25.json`](../logs/samples/capacity/metrics-after-25.json)     |
| 50 RPS    | [`k6-50.out`](../logs/samples/capacity/k6-50.out)   | [`metrics-before-50.json`](../logs/samples/capacity/metrics-before-50.json)     | [`metrics-after-50.json`](../logs/samples/capacity/metrics-after-50.json)     |
| 100 RPS   | [`k6-100.out`](../logs/samples/capacity/k6-100.out) | [`metrics-before-100.json`](../logs/samples/capacity/metrics-before-100.json)   | [`metrics-after-100.json`](../logs/samples/capacity/metrics-after-100.json)   |
| 200 RPS   | [`k6-200.out`](../logs/samples/capacity/k6-200.out) | [`metrics-before-200.json`](../logs/samples/capacity/metrics-before-200.json)   | [`metrics-after-200.json`](../logs/samples/capacity/metrics-after-200.json)   |
| 400 RPS   | [`k6-400.out`](../logs/samples/capacity/k6-400.out) | [`metrics-before-400.json`](../logs/samples/capacity/metrics-before-400.json)   | [`metrics-after-400.json`](../logs/samples/capacity/metrics-after-400.json)   |
| 800 RPS   | [`k6-800.out`](../logs/samples/capacity/k6-800.out) | [`metrics-before-800.json`](../logs/samples/capacity/metrics-before-800.json)   | [`metrics-after-800.json`](../logs/samples/capacity/metrics-after-800.json)   |
| 1 600 RPS | [`k6-1600.out`](../logs/samples/capacity/k6-1600.out) | [`metrics-before-1600.json`](../logs/samples/capacity/metrics-before-1600.json) | [`metrics-after-1600.json`](../logs/samples/capacity/metrics-after-1600.json) |
| 2 400 RPS | [`k6-2400.out`](../logs/samples/capacity/k6-2400.out) | [`metrics-before-2400.json`](../logs/samples/capacity/metrics-before-2400.json) | [`metrics-after-2400.json`](../logs/samples/capacity/metrics-after-2400.json) |

Untuk cross-check semua angka sekaligus:

```bash
cd sample-apps/payment-gateway
DIR=logs/samples/capacity   # lihat snippet di section "Ekstraksi data per step"
```

| Target RPS | Delivered RPS | % target | p50     | p95      | p99    | fail %  | CPU delta (ms/60s) | CPU / req |
|-----------:|--------------:|---------:|--------:|---------:|-------:|--------:|-------------------:|----------:|
|       25   |        22.9   |    92%   |  138 ms |   215 ms |   4 s  |   7.11% |            1 673   | 1.11 ms   |
|       50   |        44.9   |    90%   |  134 ms |   206 ms | 397 ms |   7.85% |            2 068   | 0.69 ms   |
|      100   |        91.4   |    91%   |  126 ms |   190 ms | 3.39 s |   7.46% |            3 685   | 0.61 ms   |
|      200   |       177.4   |    89%   |  126 ms |   190 ms | 3.59 s |   7.99% |            7 027   | 0.59 ms   |
|      400   |       357.2   |    89%   |  125 ms |   189 ms | 3.98 s |   7.99% |           12 637   | 0.53 ms   |
|      800   |       710.4   |    89%   |  128 ms |   194 ms | 3.83 s |   8.05% |           25 031   | 0.52 ms   |
|     1 600  |     1 365.9   |    85%   |  483 ms |  1.58 s  | 3.93 s |  23.63% |           41 050   | 0.43 ms*  |
|     2 400  |     1 909.5   |    80%   |  419 ms |  1.54 s  | 3.64 s |  51.45% |           38 661   | 0.27 ms*  |

*Di 1600 dan 2400 RPS, banyak request ditolak cepat oleh nginx (504) sebelum
masuk ke Node, jadi CPU / req yang diukur di Node terlihat lebih rendah.
CPU delta yang nyata sudah mendekati batas 1 core.

### Interpretasi per range

**25–800 RPS — flat region**

p50 dan p95 praktis tidak bergerak (126–138 ms dan 189–215 ms). `fail %`
tetap di 7–8 % yang cocok dengan `successRate=0.92` yang disimulasikan —
jadi SEMUA error adalah bisnis, bukan infra. CPU / req turun dari 1.11 ke
0.52 ms karena fixed overhead per-run (script start, GC warmup) ter-amortize
di beban tinggi. **Aplikasi tidak tertekan.**

Cek sendiri di [`k6-800.out`](../logs/samples/capacity/k6-800.out): section
`HTTP` → `http_req_duration p(95) = 193.84ms`, `http_req_failed = 8.05%`.

**Delivered RPS = 89 % dari target** di sepanjang flat region. Bukan karena
server lambat — karena 8 % request kena RC 68 (timeout simulasi 3–8 s). VU
terjebak menunggu jawaban itu dan tidak bisa kirim iterasi berikutnya secepat
target. Ini artefak skenario, bukan bottleneck.

**1 600 RPS — knee**

p50 melonjak dari 128 → 483 ms (3,8×), p95 dari 194 ms → 1.58 s (8×).
`fail %` melompat dari 8 → 23.63 % — delta 15.6 % adalah error infra
(504 Gateway Timeout dari nginx karena event loop mulai macet).

CPU delta dari [`metrics-before-1600.json`](../logs/samples/capacity/metrics-before-1600.json) `cpuUsage.userMs = 448220.68`
→ [`metrics-after-1600.json`](../logs/samples/capacity/metrics-after-1600.json) `cpuUsage.userMs = 489270.87`
= **41 050 ms / 60 s = 68 % dari satu core**. Ekstrapolasi linier dari
`0.55 ms / req × 1600 req/s = 880 ms/s CPU` = 88 % core. Dua angka
ini bilang hal yang sama: **server mulai CPU-bound di sekitar sini.**

**2 400 RPS — collapse**

`fail %` 51 % — lebih dari separuh request gagal. p95 tetap 1.54 s (artefak:
request yang gagal FAST menarik median ke bawah, sementara request yang
sempat masuk Node menghabiskan budget timeout nginx 30 s). `max` latency
59.74 s = timeout klien k6.

Bukti tambahan di [`k6-2400.out`](../logs/samples/capacity/k6-2400.out) baris
terakhir: `# === Collapsed 67 795 "Request Failed" warning lines (EOF errors) ===`.
Itu adalah connection-reset dari nginx karena accept queue jebol — indikator
kuat bahwa server bukan "lambat", tapi **menolak** koneksi.

Di level ini, aplikasi tidak berfungsi sebagai API pembayaran — ini mode
meltdown. Produksi tidak pernah boleh mendekati sini.

### Knee vs SLO-safe max

Dengan SLO hipotetis:

- p95 < 500 ms
- Error rate infra (non-bisnis) < 1 %

→ **SLO-safe max ≈ 800 RPS** (p95 = 194 ms, infra-error ≈ 0.05 %).

Rekomendasi operasional: beroperasi di 60–70 % dari SLO-safe max = **480–560 RPS**
dalam kondisi normal. Alarm P2 saat sustained > 700 RPS ≥ 5 menit.

### Bottleneck utama

Di workload default (tidak ada CPU burn, tidak ada retention), bottleneck
yang tercapai duluan adalah:

1. **Event loop Node** — saat latency sintetik `sleep()` tidak ada
   masalah, HTTP parsing + routing + logging butuh ~0.55 ms / req dari
   single-thread JS. Saturasi 1 core terjadi sekitar **1 800 RPS**.
2. **Network + nginx accept queue** — tidak tercapai sampai 2 400 RPS.
3. **Upstream simulasi bank** — `sleep()` tidak konsumsi resource sistem
   nyata, jadi tidak jadi bottleneck di simulator. Di produksi, inilah
   yang **paling mungkin** jadi bottleneck (connection pool bank, rate
   limit, per-account locking).

Catatan: karena bank connector pakai `await sleep()` yang async dan ringan,
**ribuan request bisa "sedang menunggu" sekaligus** tanpa biaya CPU atau
memory. Di produksi nyata, call ke upstream akan punya batasan connection
pool dan mungkin serialisasi per-account — benchmark ini tidak mensimulasi
itu dan akan memberi angka terlalu optimis.

### Memory

Selama seluruh tes, `rssMb` hanya bergerak dari 311 MB → 318 MB (< 2 %).
Tidak ada indikasi leak. Ini expected: retensi OFF, logging pakai pino
yang append ke file tanpa buffering dalam heap.

## Yang tidak ditangkap oleh tes ini

Perhatikan batasan berikut sebelum meng-ekstrapolasi hasil ke produksi:

1. **Workload homogen** — tes pakai distribusi method/amount seragam.
   Produksi bisa miring (70 % QRIS). Throughput bisa berbeda kalau satu
   method punya path code yang lebih mahal.
2. **Payload kecil (~120 bytes request, ~200 bytes response)**. Endpoint
   yang balik payload besar (> 10 KB) akan jauh lebih cepat CPU-bound karena
   JSON serialization.
3. **Tidak ada TLS** — nginx di training running HTTP saja. TLS handshake
   biasanya menambah 1–3 ms CPU per koneksi.
4. **Tanpa caching antar-request** — produksi mungkin punya Redis/Memcached
   yang ikut jadi bottleneck.
5. **Client tunggal** — k6 dijalankan dari satu laptop. Di beban > 2000 RPS,
   bottleneck bisa di klien (CPU laptop, outbound socket pool, VPN
   bandwidth) bukan di server. Indikator: kalau CPU delta server masih jauh
   dari saturasi tapi latency naik, cek klien dulu.
6. **1-menit runs** — tidak menangkap memory drift jangka panjang, disk
   I/O (log rotation), atau degradasi karena file handle leak.

Untuk kesimpulan produksi, ulangi benchmark di staging yang mirror
produksi, dengan workload mix yang direkam dari traffic nyata.

## Next steps

1. **Ulang dengan CPU simulation ON** (`CPU_PROBABILITY=0.3 CPU_HASH_ROUNDS=50000`)
   untuk melihat kapasitas aplikasi yang benar-benar CPU-bound di fraud
   scoring. Knee akan turun drastis — mungkin ke 50–100 RPS.
2. **Scale horizontal** — jalankan 2 atau 3 instance Node di belakang nginx
   upstream. Node single-thread, jadi horizontal scaling = cara utama
   menaikkan kapasitas Node app.
3. **Per-method profile** — tes dengan `{"method":"QRIS"}` saja, lalu
   `{"method":"CREDIT_CARD"}` saja, bandingkan p95 dan CPU / req. Deteksi
   method mana yang lebih mahal di path CPU.
4. **Long-running soak** — 2 jam di 70 % dari SLO-safe max. Cari slow
   leak, disk fill, atau log throughput yang nyangkut.
5. **Ukur dari dalam VM** — `BASE_URL=http://127.0.0.1` dari dalam server
   menghilangkan variabel VPN/network. Bandingkan dengan hasil dari laptop;
   selisihnya adalah biaya jaringan.
