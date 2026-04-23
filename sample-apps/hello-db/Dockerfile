# ---- stage 1: build ----
FROM golang:1.23-alpine AS build

WORKDIR /src

# Salin dulu manifest, download dependency. Layer ini ter-cache selama
# go.mod / go.sum tidak berubah — build ulang jauh lebih cepat.
COPY go.mod go.sum ./
RUN go mod download

# Salin source, compile. CGO_ENABLED=0 memaksa static binary supaya bisa
# jalan di image scratch (tidak ada libc). -ldflags "-s -w" strip symbol table
# untuk mengecilkan binary.
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build \
        -ldflags="-s -w" \
        -o /out/hello-db .

# ---- stage 2: runtime ----
# scratch = image kosong, tanpa shell, tanpa package manager, tanpa apa pun.
# Hanya binary + CA certs yang dibawa ke sini. Hasil image < 15 MB.
FROM scratch

# CA certs diperlukan kalau nanti app ingin panggil HTTPS endpoint.
# Dibawa dari stage build (alpine punya ca-certificates terpasang default).
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

COPY --from=build /out/hello-db /hello-db

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/hello-db", "-check"]

# Jalan sebagai uid non-root (scratch tidak punya /etc/passwd, tapi kernel
# tetap menghormati numeric uid/gid).
USER 65534:65534

EXPOSE 8080

ENTRYPOINT ["/hello-db"]
