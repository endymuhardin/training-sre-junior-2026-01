# Day-5 Demo — High Availability, Load Balancing, Failover

Dua demo terpisah, masing-masing fokus di satu layer supaya compose file tetap
kecil dan mudah dibaca:

| File                         | Layer             | Cakupan                            |
|------------------------------|-------------------|------------------------------------|
| `docker-compose.ha.yml`      | Aplikasi + LB     | 3 instance app, HAProxy, failover  |
| `docker-compose.pg-ha.yml`   | Database          | Primary + hot standby, failover    |

Keduanya pakai image dan skema tabel yang sama (`hello-db` Go + Postgres),
tapi **tidak dijalankan bersamaan**. Pilih satu sesuai topik yang dibahas.

---

## 1. App-tier HA + Load Balancing + Failover

### Topologi

```mermaid
flowchart LR
  client([client / curl])
  lb[HAProxy<br/>:8080 traffic<br/>:8404 stats]
  app1[app1<br/>INSTANCE_ID=app1]
  app2[app2<br/>INSTANCE_ID=app2]
  app3[app3<br/>INSTANCE_ID=app3]
  db[(Postgres<br/>host :25432 → container :5432)]

  client -->|HTTP| lb
  lb -->|roundrobin + /health check| app1
  lb --> app2
  lb --> app3
  app1 --> db
  app2 --> db
  app3 --> db
```

Apa yang di-demo-kan di layer ini:

- **HA**: 3 instance app berjalan paralel. Matinya 1 instance tidak berarti
  service down — 2 yang lain menyerap traffic.
- **Load Balancing**: HAProxy membagi request round-robin. Client tidak tahu
  instance mana yang akan meng-handle request-nya.
- **Failover (health-check based)**: HAProxy probe `/health` tiap 2 detik.
  Instance yang gagal 2× berturut-turut di-flag DOWN dan dikeluarkan dari
  rotasi; saat pulih, masuk kembali.

### Cara menjalankan

```bash
cd sample-apps/hello-db
docker compose -f docker-compose.ha.yml up -d
```

Tunggu semua service `healthy`:

```bash
docker compose -f docker-compose.ha.yml ps
```

### Observasi load balancing

Setiap response membawa header `X-Instance-Id` — ditambahkan oleh middleware
di [`main.go`](./main.go). Headernya lolos melewati HAProxy.

```bash
for i in $(seq 1 6); do
  curl -sSI http://localhost:8080/whoami | grep -i x-instance-id
done
```

Expected output:

```
x-instance-id: app1
x-instance-id: app2
x-instance-id: app3
x-instance-id: app1
x-instance-id: app2
x-instance-id: app3
```

Endpoint `/whoami` juga mengembalikan JSON:

```bash
curl -sS http://localhost:8080/whoami | jq
# { "instance": "app2", "servedAt": "2026-04-24T01:45:12.123Z" }
```

`INSTANCE_ID` di-set via env var di compose — **tidak di-persist ke DB**.
Sifatnya ephemeral: container diganti, ID bisa berubah (atau sama saja kalau
operator men-set ulang).

### Observasi failover

Matikan salah satu instance:

```bash
docker compose -f docker-compose.ha.yml stop app2
```

Tunggu ~6 detik (2 detik probe × 2 fails berturut-turut + buffer), lalu ulangi
request:

```bash
for i in $(seq 1 6); do
  curl -sS http://localhost:8080/whoami | jq -r .instance
done
# app1 app3 app1 app3 app1 app3
```

HAProxy otomatis skip `app2`. Hidupkan kembali:

```bash
docker compose -f docker-compose.ha.yml start app2
```

~6 detik (probe × 2 success → rise) app2 masuk lagi ke rotasi.

### Stats page HAProxy

Buka di browser: `http://localhost:8404/stats` (user: `admin`, pass: `admin`).

Halaman ini menampilkan:

- Status tiap backend (UP / DOWN)
- Request count, error count
- Active vs queued connections
- Bytes in/out per backend

Refresh tiap 5 detik. Saat demo failover, baris backend yang di-stop berubah
warna → bukti visual bahwa HAProxy melihat perubahan status.

### File yang relevan

- [`docker-compose.ha.yml`](./docker-compose.ha.yml) — definisi service
- [`haproxy.cfg`](./haproxy.cfg) — frontend, backend, resolver, stats
- [`main.go`](./main.go) — handler `/whoami`, middleware `X-Instance-Id`

### Tear down

```bash
docker compose -f docker-compose.ha.yml down -v
```

---

## 2. Postgres HA — Primary + Hot Standby + Manual Failover

### Topologi

```mermaid
flowchart LR
  client([client / psql])
  primary[(pg-primary<br/>host :25432<br/>writable)]
  standby[(pg-standby<br/>host :25433<br/>hot standby, read-only)]

  client -->|read+write| primary
  client -.->|read saja| standby
  primary ==>|streaming replication<br/>WAL| standby
```

Apa yang di-demo-kan di layer ini:

- **Streaming replication**: WAL dari primary di-stream ke standby via
  koneksi `replication` (role `replicator`). Di-bootstrap sekali oleh
  `pg_basebackup --write-recovery-conf`.
- **Hot standby**: standby menerima query `SELECT` (tidak harus menunggu
  failover untuk baca data).
- **Manual failover**: saat primary mati, operator men-jalankan
  `pg_ctl promote` di standby → standby berubah jadi writable primary baru.

### Cara menjalankan

```bash
cd sample-apps/hello-db
docker compose -f docker-compose.pg-ha.yml up -d
```

Tunggu kedua container `healthy`:

```bash
docker compose -f docker-compose.pg-ha.yml ps
```

Bootstrap standby butuh ~10-20 detik (pg_basebackup harus transfer initial
snapshot dari primary).

### Verifikasi replikasi

Tulis di primary → baca di standby:

```bash
# tulis
docker compose -f docker-compose.pg-ha.yml exec pg-primary \
  psql -U hello -d hellodb -c \
  "CREATE TABLE t(id int); INSERT INTO t VALUES (1),(2),(3);"

# baca — data sudah nyampe
docker compose -f docker-compose.pg-ha.yml exec pg-standby \
  psql -U hello -d hellodb -c "SELECT * FROM t ORDER BY id;"
```

Konfirmasi standby memang read-only:

```bash
docker compose -f docker-compose.pg-ha.yml exec pg-standby \
  psql -U hello -d hellodb -c "INSERT INTO t VALUES (99);"
# ERROR: cannot execute INSERT in a read-only transaction
```

Lihat status replikasi dari primary:

```bash
docker compose -f docker-compose.pg-ha.yml exec pg-primary \
  psql -U hello -d hellodb -c \
  "SELECT application_name, state, sync_state, client_addr FROM pg_stat_replication;"
```

Kolom penting:

- `state=streaming` — koneksi WAL aktif
- `sync_state=async` — default; tidak menunggu ack standby sebelum commit

### Demo manual failover

Skenario: primary crash, operator harus promote standby supaya service tetap
menerima write.

```mermaid
sequenceDiagram
  participant O as Operator
  participant P as pg-primary
  participant S as pg-standby
  participant C as Client

  Note over P,S: state awal: replikasi normal
  P->>S: stream WAL
  P--xP: crash / stopped
  C->>P: INSERT... (gagal, tidak ada primary)
  O->>S: pg_ctl promote
  S->>S: rename standby.signal, buka write
  C->>S: INSERT... (berhasil, sekarang S adalah primary)
```

Langkah:

```bash
# 1. matikan primary
docker compose -f docker-compose.pg-ha.yml stop pg-primary

# 2. promote standby jadi primary baru
docker compose -f docker-compose.pg-ha.yml exec -u postgres pg-standby \
  pg_ctl promote -D /var/lib/postgresql/data
# Output: "server promoted"

# 3. standby sekarang writable
docker compose -f docker-compose.pg-ha.yml exec pg-standby \
  psql -U hello -d hellodb -c "INSERT INTO t VALUES (42); SELECT * FROM t ORDER BY id;"
```

Setelah promote, standby **tidak bisa dibalik jadi standby lagi** otomatis —
butuh re-bootstrap via `pg_basebackup` baru dari primary yang hidup. Ini
pola umum: failover itu satu-arah, untuk balik ke topologi asli butuh
operasi eksplisit (sering disebut "failback").

### Batasan demo ini

- **Manual, bukan otomatis**. Di produksi dipakai alat seperti
  [Patroni](https://github.com/patroni/patroni), `pg_auto_failover`, atau
  leader-election berbasis etcd/Consul.
- **Tidak ada VIP / connection routing otomatis**. Aplikasi masih hard-code
  `DB_HOST=pg-primary`. Saat failover, butuh ganti config aplikasi atau
  tambah proxy (PgBouncer, HAProxy, Pgpool-II).
- **Async replication**. Write yang sudah commit di primary bisa hilang
  kalau primary crash sebelum WAL sampai ke standby. Untuk zero data loss
  pakai `synchronous_commit=on` + `synchronous_standby_names`.

### File yang relevan

- [`docker-compose.pg-ha.yml`](./docker-compose.pg-ha.yml) — primary + standby
- [`pg-ha/primary-init.sh`](./pg-ha/primary-init.sh) — bikin role replicator,
  tambah pg_hba
- [`pg-ha/standby-entrypoint.sh`](./pg-ha/standby-entrypoint.sh) — bootstrap
  via `pg_basebackup` kalau data dir kosong

### Tear down

```bash
docker compose -f docker-compose.pg-ha.yml down -v
```

---

## Lab: Skenario Failover

Dua drill praktis. Masing-masing bisa dikerjakan independen. Target waktu
~20 menit per drill.

### Lab A — Failover Instance Aplikasi

**Tujuan**: peserta dapat (1) mendeteksi instance down, (2) membuktikan LB
melakukan rerouting otomatis, (3) mengukur waktu detect+recovery.

**Pre-requisite**: `docker-compose.ha.yml` sudah running, semua container
healthy (`docker compose -f docker-compose.ha.yml ps`).

#### Setup — dua terminal

**Terminal 1 (observer)** — generator traffic dan log real-time:

```bash
while true; do
  printf "%s " "$(date +%H:%M:%S)"
  curl -m 2 -sS http://localhost:8080/whoami \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['instance'])" \
    || echo "ERROR"
  sleep 0.5
done
```

Buka juga stats HAProxy di browser: `http://<host>:8404/stats`
(user: `admin`, pass: `admin`). Refresh otomatis tiap 5 detik.

**Terminal 2 (operator)** — tempat meng-eksekusi failure injection.

#### Langkah drill

1. **Baseline** — amati Terminal 1 selama ~10 detik. Catat:
   - Sebaran instance dalam 10 request terakhir (harus ~3-3-4 antara
     app1/app2/app3).
   - Stats page: semua baris backend hijau (status `UP`).

2. **Inject failure — SIGKILL** (simulasi crash mendadak, bukan graceful):
   ```bash
   docker compose -f docker-compose.ha.yml kill app2
   ```
   Catat `T0` = waktu eksekusi.

3. **Observasi deteksi** di Terminal 1:
   - `T1` = waktu `app2` terakhir muncul.
   - `T2` = waktu pertama kali TIDAK ada `app2` selama 5 request berturut-turut.
   - Detection time = `T2 − T0`. Bandingkan dengan `inter 2s × fall 2` = 4 detik.
   - Apakah ada baris `ERROR`? Kalau ada, berapa banyak dari total request
     selama window?

4. **Observasi stats page** — `app2` harus berpindah warna ke merah, kolom
   `LastChk` menunjukkan response error atau timeout, kolom `Chk Fail`
   bertambah.

5. **Recovery** — nyalakan kembali:
   ```bash
   docker compose -f docker-compose.ha.yml start app2
   ```
   Catat `T3` = waktu eksekusi.

6. **Observasi re-entry**:
   - `T4` = waktu `app2` muncul pertama kali di Terminal 1 lagi.
   - Recovery time = `T4 − T3`. Bandingkan dengan `inter 2s × rise 2` ≈ 4 detik
     (plus boot container + initial ping DB).

7. **Eksperimen pembanding — `stop` vs `kill`**:
   ```bash
   docker compose -f docker-compose.ha.yml stop app3     # SIGTERM, graceful
   # tunggu 10 detik, amati
   docker compose -f docker-compose.ha.yml start app3
   ```
   Apakah `Detection time` beda dibanding `kill`? Kenapa?

#### Deliverable peserta

Laporan singkat berisi:

- Timeline dengan 4 timestamp (T0–T4) dan hitung selisihnya.
- Jumlah request loss (baris ERROR) selama window failover, sebagai persen
  dari total request di window itu.
- Jawaban: kenapa dari sudut pandang client, request tidak gagal total
  meski ada 1 backend mati?
- Jawaban: beda perilaku `kill` vs `stop`, dan mana yang mirip skenario
  "server crash" vs "deploy / restart".

---

### Lab B — Failover Primary Database

**Tujuan**: peserta dapat (1) membuktikan replikasi streaming bekerja,
(2) men-simulasikan primary mati, (3) men-promote standby jadi primary baru,
(4) menjelaskan risiko split-brain.

**Pre-requisite**: `docker-compose.pg-ha.yml` running, kedua container healthy.

#### Setup shortcut

Supaya perintah pendek:

```bash
alias dc="docker compose -f docker-compose.pg-ha.yml"
```

#### Langkah drill

1. **Baseline — siapkan data di primary**:
   ```bash
   dc exec pg-primary psql -U hello -d hellodb <<-SQL
     CREATE TABLE IF NOT EXISTS orders (
       id BIGSERIAL PRIMARY KEY,
       item TEXT NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );
     INSERT INTO orders (item) VALUES ('baseline-1'), ('baseline-2'), ('baseline-3');
   SQL
   ```

2. **Verifikasi replikasi** — data harus sudah sampai di standby:
   ```bash
   dc exec pg-standby psql -U hello -d hellodb -c "SELECT count(*) FROM orders;"
   # expected: count = 3
   ```

3. **Cek status replikasi dari primary**:
   ```bash
   dc exec pg-primary psql -U hello -d hellodb -c \
     "SELECT application_name, state, sync_state, replay_lag FROM pg_stat_replication;"
   ```
   Amati `state = streaming`. `replay_lag` harusnya null / sangat kecil.

4. **Konfirmasi peran tiap node**:
   ```bash
   dc exec pg-primary psql -U hello -d hellodb -c "SELECT pg_is_in_recovery();"
   # expected: f (false = primary)
   dc exec pg-standby psql -U hello -d hellodb -c "SELECT pg_is_in_recovery();"
   # expected: t (true = standby)
   ```

5. **Simulasi outage — matikan primary**:
   ```bash
   dc stop pg-primary
   ```

6. **Efek ke client**. Coba `INSERT` dari standby SEBELUM promote:
   ```bash
   dc exec pg-standby psql -U hello -d hellodb \
     -c "INSERT INTO orders (item) VALUES ('during-outage');"
   ```
   Expected error: `cannot execute INSERT in a read-only transaction`.

   **Pertanyaan**: apa yang menyebabkan standby tetap read-only meski primary
   mati? (Hint: file `standby.signal` di `$PGDATA` + `primary_conninfo` di
   `postgresql.auto.conf`.)

7. **Promote standby jadi primary baru**:
   ```bash
   dc exec -u postgres pg-standby pg_ctl promote -D /var/lib/postgresql/data
   # output: server promoted
   ```

8. **Verifikasi peran berubah**:
   ```bash
   dc exec pg-standby psql -U hello -d hellodb -c "SELECT pg_is_in_recovery();"
   # expected sekarang: f
   ```

9. **Write test pada primary baru**:
   ```bash
   dc exec pg-standby psql -U hello -d hellodb \
     -c "INSERT INTO orders (item) VALUES ('after-promote'); SELECT * FROM orders ORDER BY id;"
   ```

10. **Demo split-brain (edukatif, BUKAN praktik produksi)**:
    ```bash
    # hidupkan kembali primary lama tanpa re-konfigurasi
    dc start pg-primary
    # tulis di primary lama (yang seharusnya sudah tidak valid)
    dc exec pg-primary psql -U hello -d hellodb \
      -c "INSERT INTO orders (item) VALUES ('zombie-primary'); SELECT count(*) FROM orders;"
    ```
    Bandingkan `count` di kedua node — berbeda. Data sudah diverge.

#### Deliverable peserta

- Output `pg_stat_replication` di langkah 3.
- Hasil `pg_is_in_recovery()` sebelum dan sesudah promote di kedua node.
- Jawaban: apa yang secara teknis mengubah standby jadi primary setelah
  `pg_ctl promote`? (Hint: standby.signal dihapus, WAL replay selesai,
  node buka untuk write.)
- Jawaban: dari langkah 10, skenario split-brain menghasilkan divergensi
  data. Sebut 2 mekanisme produksi untuk mencegahnya (contoh: STONITH,
  quorum-based leader election, VIP + fencing, synchronous replication
  dengan majority ack).

#### Reset

```bash
dc down -v && dc up -d
```

Butuh ~20-30 detik sampai kedua container healthy kembali (pg_basebackup
harus re-bootstrap standby dari primary yang baru dibuat).

---

## Latihan

1. **Zero-downtime deploy**. Di `docker-compose.ha.yml`, tambahkan
   `build: .` pada service `app1` (sementara menimpa `image:`). Edit
   `main.go` (misal ubah pesan di `/whoami`), jalankan
   `docker compose -f docker-compose.ha.yml up -d --build app1`. Amati
   di stats HAProxy: saat app1 restart, trafik kontinu dilayani app2/app3.
   Setelah selesai, kembalikan service ke image versioned supaya konsisten
   dengan peserta lain.
2. **Kill yang tidak bersih**. `docker compose kill app3` (SIGKILL, bukan
   stop). Berapa detik sampai HAProxy menandainya DOWN? Bandingkan dengan
   `stop`. Kenapa beda?
3. **Ubah health check jadi `/ready`** di `haproxy.cfg`. Stop container `db`
   (pakai `docker compose -f docker-compose.ha.yml stop db`). Apa yang
   terjadi? Apakah semua app ditandai DOWN oleh LB? Diskusikan kenapa
   liveness vs readiness penting untuk health-check LB.
4. **Lag replikasi buatan**. Di pg-primary, tulis banyak data:
   `INSERT INTO t SELECT generate_series(1, 1000000);`. Sambil jalan,
   query di pg-primary: `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),
   replay_lsn) AS lag_bytes FROM pg_stat_replication;`.
   Amati angka naik → turun.
5. **Failback**. Setelah pg-primary mati + pg-standby di-promote, buat
   node baru untuk jadi standby dari primary baru. Hint: perlu
   `pg_basebackup` dari node yang sekarang primary, dan update
   `primary_conninfo` di node lama (atau re-init dari kosong).
