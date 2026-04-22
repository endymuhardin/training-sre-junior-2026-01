# hello-db — Docker Compose Starter

Aplikasi minimal Go + PostgreSQL untuk mendemonstrasikan:

- **Docker Compose** — orchestration multi-container di satu file
- **Dockerfile multi-stage** — image kecil via compile di stage terpisah
- **Service discovery** bawaan compose (DNS antar-service)
- **Healthcheck + `depends_on: service_healthy`** supaya urutan start benar

Ini **bukan** showcase fitur Go atau Postgres — fungsinya sengaja 1 tabel +
4 endpoint CRUD sederhana supaya fokus bahasannya ke packaging &
orkestrasi.

## Stack

- Go 1.23 (`net/http` mux + `database/sql` + `github.com/lib/pq`)
- PostgreSQL 16 (Alpine)
- Docker + Docker Compose v2

## Struktur folder

```
hello-db/
├── main.go              # ~200 baris: HTTP server + DB layer + config
├── go.mod / go.sum      # dependency manifest
├── Dockerfile           # multi-stage: build (alpine) → scratch
├── .dockerignore        # file yang tidak ikut di-COPY ke build context
├── docker-compose.yml   # 2 service: db + app
└── README.md            # dokumen ini
```

## Endpoint

Semua endpoint di `http://localhost:8080`.

| Method | Path          | Deskripsi                                  |
|--------|---------------|--------------------------------------------|
| GET    | `/health`     | Liveness. Selalu UP. Tidak sentuh DB.      |
| GET    | `/ready`      | Readiness. Ping DB. 503 kalau DB down.     |
| GET    | `/greetings`  | Ambil 100 record terakhir.                 |
| POST   | `/greetings`  | Insert row baru. Body: `{"body":"..."}`.   |

Liveness vs readiness: liveness bilang "proses saya hidup", readiness bilang
"saya siap menerima traffic". Kubernetes / orchestrator pakai dua-duanya —
liveness untuk decide restart, readiness untuk decide routing.

## Cara menjalankan

### Semua-in-one via compose (pola yang paling sering dipakai)

```bash
cd sample-apps/hello-db

docker compose up --build         # build image + start kedua service
```

Output pertama kali akan kelihatan:

```
 ✔ Container hello-db-db-1    Healthy
 ✔ Container hello-db-app-1   Started
```

`Healthy` muncul setelah postgres lulus `pg_isready`. App baru start SETELAH
itu — ini efek `depends_on: condition: service_healthy`.

Smoke test dari terminal lain:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready

curl -X POST http://localhost:8080/greetings \
  -H 'content-type: application/json' \
  -d '{"body":"halo dunia"}'

curl http://localhost:8080/greetings
```

Hentikan:

```bash
docker compose down            # stop + hapus container & network
docker compose down -v         # + hapus volume (data Postgres hilang)
```

### Jalankan tanpa compose (manual, untuk pelajaran kontras)

```bash
# Postgres
docker run --rm -d --name pg \
  -e POSTGRES_USER=hello -e POSTGRES_PASSWORD=hello -e POSTGRES_DB=hellodb \
  -p 5432:5432 postgres:16-alpine

# App (butuh image sudah ter-build dulu)
docker build -t hello-db-app .
docker run --rm --name app \
  -e PORT=8080 \
  -e DB_HOST=host.docker.internal -e DB_PORT=5432 \
  -e DB_USER=hello -e DB_PASSWORD=hello -e DB_NAME=hellodb \
  -p 8080:8080 hello-db-app
```

Perhatikan pain-point yang dihindari docker-compose:

- Service discovery manual (`host.docker.internal` hack di Mac; di Linux
  butuh network tersendiri)
- Tidak ada auto start-order — kalau app start duluan, gagal ping DB
- Dua terminal / dua set env var
- `docker run` panjang

Compose mengenkapsulasi semua itu di satu file deklaratif.

## Konsep Docker Compose yang di-demo

### 1. Service = satu container (dengan spec)

Dua service di `docker-compose.yml`: `db` dan `app`. Compose otomatis:

- Bikin network bridge bernama `hello-db_default`
- Attach kedua container ke network itu
- Menerbitkan DNS: nama service (`db`, `app`) jadi hostname
- Hasilnya: `main.go` bisa pakai `DB_HOST: db` tanpa tahu IP

### 2. `depends_on: condition: service_healthy`

Tanpa kondisi ini, compose hanya menunggu CONTAINER db `created`, bukan
Postgres-nya siap. App bakal start, ping Postgres, fail, exit. Dengan
healthcheck `pg_isready`:

```yaml
db:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U hello -d hellodb"]
    interval: 5s
    retries: 10
```

Compose menunggu health status = `healthy` dulu baru start app.

### 3. Volume untuk persistensi DB

```yaml
volumes:
  - pgdata:/var/lib/postgresql/data
```

Data Postgres disimpan di volume `pgdata` (bukan di container filesystem).
`docker compose down` tidak menghapus volume — `down -v` yang hapus.
Berguna untuk demo: coba `down`, lalu `up`, data tetap ada.

### 4. Variable env terstruktur

Semua config app lewat env var, tidak ada file config. Di produksi ini
pola standar karena:

- Tidak ada secret di image
- Beda environment (dev, staging, prod) = beda compose / deployment
- Kubernetes ConfigMap & Secret pakai pola yang sama

App kita validasi env keras (tidak ada default) — kalau ada yang kurang,
exit dengan error:

```json
{"level":"ERROR","msg":"config load failed","err":"env var DB_HOST is required but not set"}
```

## Dockerfile — multi-stage untuk image minimal

```dockerfile
FROM golang:1.23-alpine AS build        # stage 1: compile
...
FROM scratch                             # stage 2: runtime (kosong)
COPY --from=build /out/hello-db /hello-db
```

### Kenapa multi-stage

Tanpa multi-stage, image final akan berisi seluruh toolchain Go (~800 MB).
Dengan multi-stage + scratch, hanya binary Go yang terkirim:

```bash
docker images hello-db-app
# REPOSITORY     TAG       SIZE
# hello-db-app   latest    6.18MB
```

**6.18 MB**. Bandingkan:

| Base image                   | Ukuran image final |
|------------------------------|-------------------:|
| `golang:1.23`                |              ~900 MB |
| `golang:1.23-alpine`         |              ~350 MB |
| `alpine:3.19` (copy binary)  |               ~15 MB |
| `scratch` (copy binary)      |             **~6 MB** |

Manfaat image kecil:

- Push/pull lebih cepat (CI/CD, auto-scale di k8s)
- Attack surface lebih kecil — scratch tidak punya `sh`, `cat`, `curl`,
  package manager. Kalau app di-exploit, attacker tidak punya tool apa-apa.
- Start cepat (layer kecil, image cache lebih efektif)

### Trade-off scratch

Tidak bisa `docker exec sh` ke container — tidak ada shell. Untuk debug,
pakai `docker logs` (app ini pakai slog JSON ke stdout) atau sidecar
container yang mount filesystem sama.

Kalau Anda sering perlu `exec`, pakai `gcr.io/distroless/base` atau
`alpine` sebagai base runtime — sedikit lebih besar tapi tidak kosong.

### Layer caching trick

Kenapa `COPY go.mod go.sum` duluan baru `RUN go mod download`, baru
`COPY main.go`? Docker cache per-layer: selama `go.mod` / `go.sum` tidak
berubah, layer `go mod download` dipakai lagi dari cache — build cepat
meski `main.go` diedit. Kalau `COPY . .` duluan, sedikit edit
main.go = re-download semua dependency.

## Debugging / operasi umum

```bash
# lihat log kedua service
docker compose logs -f

# log satu service saja
docker compose logs -f app

# masuk ke shell postgres
docker compose exec db psql -U hello -d hellodb
# di dalam psql:
#   \d greetings
#   SELECT * FROM greetings;

# restart app saja (tanpa stop db)
docker compose restart app

# lihat status + healthcheck
docker compose ps

# rebuild app setelah ubah main.go
docker compose up --build -d app
```

## Latihan untuk peserta

1. Matikan service `db` di tengah app running (`docker compose stop db`).
   Panggil `/ready` — harusnya balik 503. Panggil `/health` — harusnya
   tetap 200. Jelaskan kenapa liveness ≠ readiness.
2. Hapus `condition: service_healthy` dari `depends_on`. Start compose dari
   kondisi bersih (`down -v` dulu). App kemungkinan besar crash karena
   ping DB gagal di awal. Restore, jelaskan nilainya.
3. Ganti final stage Dockerfile dari `scratch` jadi `alpine:3.19`. Rebuild
   dan bandingkan `docker images`. Seberapa besar perbedaan? Kapan Anda
   akan tetap pilih alpine?
4. Tambah env var `DB_SSL` yang tidak dipakai. Coba start — apa yang
   terjadi? (spoiler: tidak apa-apa; env var tak dikenal diabaikan).
   Lalu hapus `DB_PORT` dari compose — apa yang terjadi? Konfirmasi
   pesan error dari strict config loader.
5. Hitung image size delta: bandingkan `hello-db-app` (scratch) dengan
   image Node.js `payment-gateway` (tidak di-Dockerfile-kan di repo ini,
   tapi asumsikan `node:20-alpine` base ≈ 180 MB + `node_modules` 50 MB).
   Bahas trade-off runtime size vs dev ergonomics.
