# Latihan: Hardening & Supply Chain Scanning

Latihan praktik untuk materi [`./materi-hardening-supply-chain.md`](./materi-hardening-supply-chain.md). Target praktik: dua image dari `sample-apps/`:

1. **hello-db** — Go, multi-stage build, runtime `scratch`. Dockerfile: `sample-apps/hello-db/Dockerfile`.
2. **payment-gateway** — Node.js 24 Alpine, single-stage. Dockerfile: `sample-apps/payment-gateway/Dockerfile`.

Dua image ini sengaja dipilih karena karakteristiknya berlawanan. `hello-db` sudah banyak menerapkan praktik hardening (scratch, static binary, non-root), sementara `payment-gateway` lebih konvensional (Alpine full, ada shell, ada package manager). Perbandingan hasil scan antar keduanya adalah bagian dari pelajaran.

---

## Prasyarat

Trainee menggunakan Windows. Pilih salah satu dari tiga opsi berikut:

### Opsi A (Direkomendasikan): Docker Desktop + PowerShell

Hanya butuh **Docker Desktop** yang sudah terinstall (sudah dipakai di Hari 3). Semua tool scanning dipanggil via `docker run` — tidak install apapun lagi di Windows. Cocok karena:

- Versi tool konsisten antar trainee (image tag yang sama).
- Tidak perlu PATH, winget, chocolatey, scoop.
- Uninstall = hapus image.

Simpan script berikut sebagai `docker-tools.ps1`, lalu `source` di awal setiap sesi:

```powershell
# docker-tools.ps1 — wrapper PowerShell untuk tool scanning
# Pakai: . .\docker-tools.ps1

$socket = "/var/run/docker.sock"  # Docker Desktop WSL2 backend

function trivy      { docker run --rm -v "${socket}:${socket}" -v "${PWD}:/work" -w /work aquasec/trivy:latest @args }
function grype      { docker run --rm -v "${socket}:${socket}" -v "${PWD}:/work" -w /work anchore/grype:latest @args }
function syft       { docker run --rm -v "${socket}:${socket}" -v "${PWD}:/work" -w /work anchore/syft:latest @args }
function hadolint   { docker run --rm -i hadolint/hadolint:latest hadolint @args }
function dockle     { docker run --rm -v "${socket}:${socket}" goodwithtech/dockle:latest @args }
function cosign     { docker run --rm -v "${HOME}\.docker:/root/.docker" -v "${PWD}:/work" -w /work gcr.io/projectsigstore/cosign:latest @args }
function osv-scanner { docker run --rm -v "${PWD}:/src" -w /src ghcr.io/google/osv-scanner:latest @args }
function govulncheck { docker run --rm -v "${PWD}:/src" -w /src golang:1.23-alpine sh -c "go install golang.org/x/vuln/cmd/govulncheck@latest && /go/bin/govulncheck $($args -join ' ')" }
function npm-audit   { docker run --rm -v "${PWD}:/app" -w /app node:24-alpine sh -c "npm ci --omit=dev --silent && npm audit $($args -join ' ')" }
function jq          { docker run --rm -i ghcr.io/jqlang/jq:latest @args }

Write-Host "Docker-based tools ready: trivy, grype, syft, hadolint, dockle, cosign, osv-scanner, govulncheck, npm-audit, jq"
```

Aktifkan di PowerShell:

```powershell
cd C:\path\ke\training-sre-junior-2026-01
. .\docker-tools.ps1
trivy --version
syft version
```

Semua perintah `trivy ...`, `syft ...` dst. di sisa latihan bekerja persis sama seperti tool native — function PowerShell meneruskan argumen ke container.

**Catatan path**: `${PWD}` di PowerShell menghasilkan path Windows (`C:\Users\...`), Docker Desktop mengkonversi otomatis ke path Linux di container. Selama bekerja dari dalam repo, mount `${PWD}:/work` selalu valid.

**Catatan Docker socket**: mount `/var/run/docker.sock` bekerja via WSL2 backend Docker Desktop. Tool di container bisa lihat image `hello-db:latihan` dan `payment-gateway:latihan` yang di-build lokal.

### Opsi B: VPS RHEL 9 masing-masing

Trainee sudah punya VPS RHEL 9 (dari materi Hari 3 + `ansible-deploy/`). Jalankan semua latihan di VPS:

```bash
# Dari Windows
ssh trainee@<vps-ip>

# Di VPS, clone repo (atau rsync dari laptop)
git clone https://github.com/endymuhardin/training-sre-junior-2026-01.git
cd training-sre-junior-2026-01
```

Kemudian install Docker CE dan tool scanning — ikuti **bagian RHEL 9** di Opsi C di bawah. VPS `ansible-deploy` yang ada sudah pasang EPEL + base tools (`curl`, `wget`, `git`), tapi belum pasang Docker maupun tool scanning.

Kelebihan: lingkungan identik dengan production (VPS memang Linux, SELinux enforcing, firewalld aktif — test hardening di sini paling jujur). Kekurangan: tambahan step SSH, perlu copy file output hasil scan kembali ke laptop untuk presentasi, koneksi SSH putus mengganggu alur latihan.

Bila pilih opsi ini, build image di VPS langsung: `docker build -t hello-db:latihan .` di direktori VPS.

### Opsi C: Tool native di Linux (WSL2 atau VPS RHEL 9)

Untuk trainee yang sudah nyaman di terminal Linux dan ingin eksekusi paling cepat (tanpa overhead spin-up container per-invocation). Pilih sub-bagian sesuai distro.

#### C.1 — Ubuntu / Debian (WSL2)

```bash
# Trivy
sudo apt-get install -y wget apt-transport-https gnupg
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key | sudo gpg --dearmor -o /usr/share/keyrings/trivy.gpg
echo "deb [signed-by=/usr/share/keyrings/trivy.gpg] https://aquasecurity.github.io/trivy-repo/deb generic main" \
  | sudo tee /etc/apt/sources.list.d/trivy.list
sudo apt-get update && sudo apt-get install -y trivy

# Grype, Syft
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sudo sh -s -- -b /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sudo sh -s -- -b /usr/local/bin

# Hadolint
sudo curl -L https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 \
  -o /usr/local/bin/hadolint && sudo chmod +x /usr/local/bin/hadolint

# Dockle
VERSION=$(curl -s https://api.github.com/repos/goodwithtech/dockle/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
curl -L -o /tmp/dockle.deb "https://github.com/goodwithtech/dockle/releases/download/v${VERSION}/dockle_${VERSION}_Linux-64bit.deb"
sudo dpkg -i /tmp/dockle.deb

# Cosign
sudo curl -sSfL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 \
  -o /usr/local/bin/cosign && sudo chmod +x /usr/local/bin/cosign

# jq (biasanya sudah ada)
sudo apt-get install -y jq
```

Docker Desktop di Windows meng-ekspose Docker daemon ke WSL2, jadi `docker build`, `trivy image ...`, dll. langsung bekerja tanpa konfigurasi tambahan. Tool melihat image yang sama dengan yang di Docker Desktop.

#### C.2 — RHEL 9 (VPS)

**Install Docker CE** (RHEL 9 default ke Podman, tapi latihan ini pakai Docker CE untuk konsistensi perintah dan kompatibilitas mount socket):

```bash
# Hapus podman-docker shim kalau ada (menghindari bentrok dengan docker CE)
sudo dnf remove -y podman-docker 2>/dev/null || true

# Repo resmi Docker untuk RHEL/CentOS
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# Install engine + CLI + compose plugin
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start & enable
sudo systemctl enable --now docker

# Tambahkan user ke group docker supaya tidak perlu sudo tiap kali
sudo usermod -aG docker $USER
# Logout + login ulang, atau: newgrp docker

# Verifikasi
docker version
docker compose version
```

**Install tool scanning**:

```bash
# Trivy — repo resmi Aqua Security untuk RPM
sudo tee /etc/yum.repos.d/trivy.repo >/dev/null <<'EOF'
[trivy]
name=Trivy repository
baseurl=https://aquasecurity.github.io/trivy-repo/rpm/releases/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://aquasecurity.github.io/trivy-repo/rpm/public.key
EOF
sudo dnf install -y trivy

# Grype, Syft — installer shell, OS-agnostic (deteksi arch otomatis)
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sudo sh -s -- -b /usr/local/bin
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sudo sh -s -- -b /usr/local/bin

# Hadolint — static binary
sudo curl -L https://github.com/hadolint/hadolint/releases/latest/download/hadolint-Linux-x86_64 \
  -o /usr/local/bin/hadolint && sudo chmod +x /usr/local/bin/hadolint

# Dockle — paket RPM
VERSION=$(curl -s https://api.github.com/repos/goodwithtech/dockle/releases/latest | grep '"tag_name"' | sed -E 's/.*"v([^"]+)".*/\1/')
curl -L -o /tmp/dockle.rpm "https://github.com/goodwithtech/dockle/releases/download/v${VERSION}/dockle_${VERSION}_Linux-64bit.rpm"
sudo rpm -Uvh /tmp/dockle.rpm

# Cosign — static binary
sudo curl -sSfL https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64 \
  -o /usr/local/bin/cosign && sudo chmod +x /usr/local/bin/cosign

# jq — dari EPEL (EPEL sudah diaktifkan oleh ansible-deploy/roles/common)
sudo dnf install -y jq

# Go toolchain (untuk Latihan 4 — govulncheck native)
sudo dnf install -y golang
# Catatan: versi dari repo RHEL AppStream bisa lebih lama dari yang dipakai hello-db (1.23).
# Kalau butuh versi tepat, download tarball resmi:
#   curl -LO https://go.dev/dl/go1.23.0.linux-amd64.tar.gz
#   sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.23.0.linux-amd64.tar.gz
#   echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc && source ~/.bashrc
```

**Catatan khusus RHEL 9 — perlu diperhatikan saat latihan**:

1. **SELinux enforcing**. Cek dengan `getenforce`. Beberapa latihan runtime (Latihan 7) mount `/var/run/docker.sock`, readonly rootfs, tmpfs — semua bekerja dengan SELinux aktif tapi bisa butuh label `:z` / `:Z` di volume bila ada permission denied:
   ```bash
   docker run -v ./data:/data:Z ...
   ```
   Jangan `setenforce 0` untuk latihan — justru SELinux enforcing adalah bagian realita production dan memperkuat pelajaran defense-in-depth.

2. **Firewalld aktif**. Port yang dipakai latihan (3001, 3002, 5000, 8080, 8081, 8082) diblok secara default dari luar VPS. Dua opsi:
   - Akses hanya dari dalam VPS (lewat SSH tunnel atau `curl localhost:...` langsung di VPS) — direkomendasikan, tidak perlu ubah firewall.
   - Buka port untuk pengetesan dari luar (mis. laptop):
     ```bash
     sudo firewall-cmd --add-port=5000/tcp --add-port=8080/tcp --add-port=8082/tcp
     # Tambahkan --permanent kalau mau persist reboot.
     ```
     Ingat tutup lagi setelah latihan selesai: `sudo firewall-cmd --remove-port=5000/tcp ...`.

3. **SSH tunnel untuk UI Dependency-Track (Latihan 10)**. Dari laptop Windows/macOS:
   ```bash
   ssh -L 8080:localhost:8080 -L 8082:localhost:8082 trainee@<vps-ip>
   ```
   Buka browser lokal ke `http://localhost:8080` — akses aman tanpa membuka port di firewalld.

4. **cgroup v2**. RHEL 9 default cgroup v2, Docker CE 24+ sudah kompatibel. `--memory`, `--cpus`, `--pids-limit` di Latihan 7 bekerja penuh.

5. **Rootless Docker (opsional)**. Bila tidak ingin tambahkan user ke group `docker` (privileged equivalent), pakai rootless:
   ```bash
   dockerd-rootless-setuptool.sh install
   export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
   ```
   Tradeoff: beberapa latihan runtime hardening lebih mudah ditelusuri di mode standard — pilih mode standard dulu untuk latihan pertama.

### Rekomendasi

| Tujuan | Pilihan |
|---|---|
| Alur latihan paling mulus untuk trainee Windows | **Opsi A** (Docker + PowerShell wrapper) |
| Latihan sekaligus simulasi production | Opsi B (VPS) |
| Sudah nyaman WSL2, ingin cepat | Opsi C |

Seluruh langkah di bawah ditulis dalam sintaks bash/Linux. Opsi A (PowerShell) bekerja identik karena function wrapper — hanya operator redirect/pipe yang mungkin berbeda (PowerShell: `|`, `>`, `>>` sama dengan bash; heredoc `<<EOF` pakai `@"..."@` di PowerShell).

### Verifikasi & Build Image Target

```bash
# Verifikasi tool (Opsi A: jalankan di PowerShell setelah source docker-tools.ps1)
trivy --version
grype version
syft version
hadolint --version
dockle --version
cosign version

# Build dua image target
cd sample-apps/hello-db
docker build -t hello-db:latihan .

cd ../payment-gateway
docker build -t payment-gateway:latihan .

# Verifikasi
docker images | grep latihan
```

---

## Latihan 1 — Inspeksi Image

### Tujuan
Mengerti apa saja yang benar-benar masuk ke image: ukuran, layer, metadata, user, entrypoint.

### Langkah

```bash
# Ukuran & layer
docker images hello-db:latihan payment-gateway:latihan
docker history hello-db:latihan
docker history payment-gateway:latihan

# Metadata lengkap
docker inspect hello-db:latihan | jq '.[0].Config'
docker inspect payment-gateway:latihan | jq '.[0].Config'

# User yang menjalankan process (penting)
docker inspect hello-db:latihan | jq '.[0].Config.User'
docker inspect payment-gateway:latihan | jq '.[0].Config.User'
```

### Pertanyaan

1. Image mana yang lebih besar? Kira-kira kenapa?
2. `hello-db` berjalan sebagai UID berapa? `payment-gateway` sebagai user apa? Apakah ada yang jalan sebagai root?
3. Dari `docker history`, layer mana yang paling besar di `payment-gateway`? Apakah bisa dikecilkan?
4. Apakah ada `ENV` yang berisi value sensitif? (harusnya tidak — cek sebagai latihan).

### Expected Findings
- `hello-db`: ukuran ~10–15 MB, satu layer besar (`ADD` binary), user `65534:65534`.
- `payment-gateway`: ukuran ~150–200 MB, layer terbesar dari `npm ci`, user `node`.

---

## Latihan 2 — Lint Dockerfile

### Tujuan
Deteksi anti-pattern di Dockerfile sebelum image dibangun.

### Langkah

```bash
# Hadolint — syntax & best practice
hadolint sample-apps/hello-db/Dockerfile
hadolint sample-apps/payment-gateway/Dockerfile

# Dockle — CIS Docker Benchmark terhadap image yang sudah dibangun
dockle hello-db:latihan
dockle payment-gateway:latihan
```

### Pertanyaan

1. Temuan apa saja yang keluar dari Hadolint? Mana yang _fatal_ (DL3xxx severity ERROR)?
2. Di Dockle, CIS control mana yang gagal? Catat nomor (`CIS-DI-xxxx`).
3. `hello-db` sudah pakai `scratch` + UID numerik — temuan Dockle biasanya lebih sedikit. Apakah ada temuan yang tetap muncul?
4. `payment-gateway` — cek apakah ada warning soal `HEALTHCHECK`, `apt-get` cache, atau `latest` tag.

### Latihan Tambahan
Perbaiki satu temuan Hadolint di `payment-gateway`. Misal bila muncul `DL3018` (pin apk version), terapkan pinning lalu build ulang dan scan lagi.

---

## Latihan 3 — Vulnerability Scanning

### Tujuan
Scan dua image terhadap CVE database, bandingkan hasil antara scanner, dan identifikasi CVE yang actionable.

### Langkah — Trivy

```bash
# Update DB dulu
trivy image --download-db-only

# Scan keduanya, tampilkan semua severity
trivy image hello-db:latihan
trivy image payment-gateway:latihan

# Fokus ke CVE yang bisa di-patch (ada fix upstream)
trivy image --severity HIGH,CRITICAL --ignore-unfixed payment-gateway:latihan

# Output JSON untuk diolah
trivy image --format json --output trivy-payment.json payment-gateway:latihan
jq '.Results[].Vulnerabilities | length' trivy-payment.json
```

### Langkah — Grype (pembanding)

```bash
grype hello-db:latihan
grype payment-gateway:latihan -o table

# Hanya high/critical yang sudah ada fix
grype payment-gateway:latihan --only-fixed -o table | awk '$5=="High" || $5=="Critical"'
```

### Pertanyaan

1. Berapa jumlah total CVE untuk tiap image?
2. Apakah Trivy dan Grype menemukan jumlah yang sama? Bila berbeda, kenapa? (petunjuk: sumber database berbeda — NVD vs GHSA vs distro OVAL).
3. Di `payment-gateway`, CVE mayoritas datang dari OS package Alpine atau dari `node_modules`?
4. Pilih satu CVE CRITICAL dan lakukan triage:
   - Apakah masuk CISA KEV? Cek di https://www.cisa.gov/known-exploited-vulnerabilities-catalog
   - Berapa EPSS score-nya? Cek di https://api.first.org/data/v1/epss?cve=CVE-YYYY-NNNN
   - Apakah library yang rentan benar-benar dipakai aplikasi (reachable)?
5. Untuk `hello-db` dengan runtime `scratch`: CVE di layer build (`golang:1.23-alpine`) apakah mempengaruhi runtime image? Kenapa?

### Expected Findings
- `hello-db` runtime stage hampir tidak punya CVE karena `FROM scratch` — hanya binary + CA certs. (CVE bila ada muncul dari runtime binary itu sendiri atau Go stdlib — scan stdlib pakai `govulncheck`.)
- `payment-gateway` biasanya punya puluhan CVE: sebagian dari Alpine package (openssl, curl, busybox), sebagian dari node_modules.

---

## Latihan 4 — Go-Specific Scanning

### Tujuan
Go punya tool khusus yang menganalisis *call graph*, bukan sekadar daftar dependency — jadi hanya CVE yang benar-benar reachable yang dilaporkan.

### Langkah

```bash
cd sample-apps/hello-db

# Install govulncheck
go install golang.org/x/vuln/cmd/govulncheck@latest

# Scan source
govulncheck ./...

# Scan binary (hasil build — lebih mendekati runtime reality)
docker run --rm -v "$PWD:/src" -w /src golang:1.23-alpine sh -c \
  "CGO_ENABLED=0 go build -o /tmp/hello-db . && \
   go install golang.org/x/vuln/cmd/govulncheck@latest && \
   /go/bin/govulncheck -mode binary /tmp/hello-db"
```

### Pertanyaan

1. Jumlah CVE dari Trivy untuk `hello-db` vs dari `govulncheck` — yang mana lebih sedikit? Kenapa?
2. Ada CVE yang dilaporkan Trivy tapi tidak dilaporkan `govulncheck`? Artinya apa?
3. `govulncheck` akan menunjukkan call trace — fungsi mana di `main.go` yang memanggil kode rentan?

---

## Latihan 5 — Node.js-Specific Scanning

### Tujuan
Node.js punya `npm audit` bawaan + OSV Scanner untuk cross-check.

### Langkah

```bash
cd sample-apps/payment-gateway

# npm audit — baca GitHub Advisory Database
npm audit
npm audit --json | jq '.metadata.vulnerabilities'

# OSV-Scanner — cross-check dengan OSV DB
docker run --rm -v "$PWD:/src" -w /src ghcr.io/google/osv-scanner:latest \
  scan source --lockfile=package-lock.json

# Socket — deteksi perilaku mencurigakan (opsional, butuh akun)
# npx @socketsecurity/cli scan ./
```

### Pertanyaan

1. `npm audit` vs Trivy image scan — siapa menemukan apa? (petunjuk: `npm audit` tidak scan OS package, Trivy scan keduanya).
2. Apakah ada `critical` di `npm audit`? Jalankan `npm audit fix --dry-run` — apakah bisa auto-fix?
3. Di `package-lock.json`, paket mana yang paling banyak muncul sebagai transitive dependency?
4. Coba tambah dependency yang diketahui rentan untuk latihan (contoh: `lodash@4.17.20`), jalankan `npm install`, lalu re-scan. Observasi berapa CVE bertambah.

```bash
# Latihan: inject vuln (JANGAN commit!)
npm install lodash@4.17.20 --save
trivy image --severity HIGH,CRITICAL payment-gateway:latihan
# Setelah selesai:
git checkout -- package.json package-lock.json
rm -rf node_modules && npm ci --omit=dev
```

---

## Latihan 6 — SBOM Generation

### Tujuan
Generate SBOM yang bisa dipakai untuk monitoring berkelanjutan dan audit.

### Langkah

```bash
mkdir -p out/sbom

# SBOM CycloneDX untuk container image
syft hello-db:latihan -o cyclonedx-json=out/sbom/hello-db.cdx.json
syft payment-gateway:latihan -o cyclonedx-json=out/sbom/payment-gateway.cdx.json

# SBOM SPDX (format alternatif)
syft payment-gateway:latihan -o spdx-json=out/sbom/payment-gateway.spdx.json

# Lihat ringkasan
syft hello-db:latihan -o table
syft payment-gateway:latihan -o table | head -40

# Count komponen
jq '.components | length' out/sbom/hello-db.cdx.json
jq '.components | length' out/sbom/payment-gateway.cdx.json
```

### Pertanyaan

1. Berapa komponen di SBOM `hello-db` vs `payment-gateway`? Rasio dengan ukuran image masuk akal?
2. Di `payment-gateway`, apakah SBOM memisahkan OS package (Alpine) dan npm package? Field apa yang membedakan (`type`, `purl`)?
3. Re-scan SBOM tanpa image: `trivy sbom out/sbom/payment-gateway.cdx.json`. Apakah hasilnya sama dengan `trivy image`?

### Bonus
Simulasikan continuous monitoring: simpan SBOM hari ini, besok (atau setelah `trivy image --download-db-only`) scan ulang SBOM yang sama. Diff hasil.

```bash
trivy sbom --format json out/sbom/payment-gateway.cdx.json > scan-hari-1.json

# ... tunggu DB update, atau simulasikan dengan --skip-db-update=false

trivy image --download-db-only
trivy sbom --format json out/sbom/payment-gateway.cdx.json > scan-hari-2.json

diff <(jq -S '.Results[].Vulnerabilities[].VulnerabilityID' scan-hari-1.json) \
     <(jq -S '.Results[].Vulnerabilities[].VulnerabilityID' scan-hari-2.json)
```

---

## Latihan 7 — Runtime Hardening

### Tujuan
Menerapkan security flag saat `docker run` dan memverifikasi container tetap berfungsi.

### Langkah

```bash
# 1. Baseline — jalankan tanpa flag tambahan
docker run -d --name pg-baseline -p 3001:3000 payment-gateway:latihan
curl -s http://localhost:3001/api/health
docker stop pg-baseline && docker rm pg-baseline

# 2. Hardened — drop semua capability + readonly rootfs + no new privileges
docker run -d --name pg-hardened \
  -p 3002:3000 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --tmpfs /app/logs:rw,noexec,nosuid,size=32m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory=256m --cpus=0.5 --pids-limit=100 \
  payment-gateway:latihan
curl -s http://localhost:3002/api/health
docker logs pg-hardened | tail -20
docker stop pg-hardened && docker rm pg-hardened

# 3. Hardened `hello-db` — lebih agresif karena scratch
docker run -d --name hello-hardened \
  -p 8081:8080 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory=64m --cpus=0.25 --pids-limit=50 \
  hello-db:latihan
curl -s http://localhost:8081/
docker stop hello-hardened && docker rm hello-hardened
```

### Pertanyaan

1. Apakah `payment-gateway` masih berfungsi dengan `--read-only`? Kalau tidak, direktori mana yang butuh tulis? (petunjuk: `/app/logs` untuk pino, `/tmp` untuk beberapa library).
2. Coba tanpa `--tmpfs /app/logs` — apa error yang muncul di `docker logs`?
3. Jalankan `docker exec pg-hardened sh` — apa yang terjadi? Bisa tidak escalate privilege di dalam container?
4. Bandingkan `docker exec hello-hardened sh` — kenapa beda hasilnya dengan `payment-gateway`?

### Test Privilege Escalation

```bash
# Di container payment-gateway, coba install tool
docker exec pg-hardened apk add curl
# Expected: gagal, karena user `node` tidak punya write ke /var/cache/apk
# dan read-only rootfs tambahan proteksi.

# Coba write ke lokasi yang tidak di-tmpfs
docker exec pg-hardened sh -c "echo test > /etc/testfile"
# Expected: "Read-only file system"
```

---

## Latihan 8 — Image Signing dengan Cosign

### Tujuan
Sign image dan verifikasi signature — simulasi supply chain protection.

### Langkah

```bash
# Setup: pakai local registry untuk latihan (tidak perlu Docker Hub)
docker run -d -p 5000:5000 --name registry registry:2

# Tag & push
docker tag hello-db:latihan localhost:5000/hello-db:latihan
docker tag payment-gateway:latihan localhost:5000/payment-gateway:latihan
docker push localhost:5000/hello-db:latihan
docker push localhost:5000/payment-gateway:latihan

# Generate key pair (untuk latihan lokal; di CI gunakan keyless/OIDC)
cosign generate-key-pair
# Output: cosign.key (private) + cosign.pub

# Sign
cosign sign --key cosign.key --allow-insecure-registry localhost:5000/hello-db:latihan
cosign sign --key cosign.key --allow-insecure-registry localhost:5000/payment-gateway:latihan

# Attach SBOM sebagai attestation
cosign attest --key cosign.key --allow-insecure-registry \
  --predicate out/sbom/hello-db.cdx.json \
  --type cyclonedx \
  localhost:5000/hello-db:latihan

# Verifikasi signature
cosign verify --key cosign.pub --allow-insecure-registry localhost:5000/hello-db:latihan

# Verifikasi attestation
cosign verify-attestation --key cosign.pub --allow-insecure-registry \
  --type cyclonedx \
  localhost:5000/hello-db:latihan | jq '.payload | @base64d | fromjson'

# Cleanup
docker rm -f registry
rm cosign.key cosign.pub
```

### Pertanyaan

1. Lihat registry setelah signing: `curl -s http://localhost:5000/v2/hello-db/tags/list`. Tag baru apa yang muncul? (petunjuk: `sha256-...sig`).
2. Ubah satu byte di image (rebuild sedikit berbeda), push, lalu verifikasi signature — apa yang terjadi?
3. Di production, kenapa lebih baik pakai keyless signing (OIDC dari CI) daripada key file?

---

## Latihan 9 — Simulasi Supply Chain Attack

### Tujuan
Memahami perspektif attacker — bagaimana paket jahat masuk ke pipeline, dan apa yang akan menangkapnya.

### Skenario A: Typosquatting

Bayangkan developer salah tulis nama paket:

```bash
cd sample-apps/payment-gateway

# "Nyaris sama" dengan paket populer — contoh hipotetik
# JANGAN install paket apapun yang dicurigai malware di mesin kerja.
# Untuk latihan, pakai dry-run:
npm view expressjs 2>&1 || echo "paket tidak ada (typo)"
npm view expresss 2>&1 || echo "paket tidak ada (typo)"

# Cek history insiden typosquat di npm:
# https://socket.dev/blog — cari "typosquat"
```

Pertanyaan: tool apa yang akan menangkap ini **sebelum** `npm install`? (petunjuk: Socket, policy di `.npmrc` untuk allowlist registry/namespace).

### Skenario B: Dependency Confusion

Buat package.json yang mereference paket internal fiktif:

```bash
cd /tmp
mkdir dep-confusion-demo && cd dep-confusion-demo
cat > package.json <<'EOF'
{
  "name": "demo-app",
  "dependencies": {
    "@myorg/internal-utils": "1.0.0"
  }
}
EOF

# Coba install — npm akan cari ke registry publik, kalau ada paket dengan nama
# sama (versi lebih tinggi) → tertarik ke paket public.
# Output akan 404 kalau tidak ada paket public matching — bagus.
npm install --dry-run 2>&1 | head -20
```

Pertanyaan:
1. Bagaimana mencegah npm mengambil paket internal dari public registry? (petunjuk: `.npmrc` dengan `@myorg:registry=https://nexus.internal/...`).
2. Apakah equivalent-nya untuk Maven? (petunjuk: `<mirrors>` di settings.xml, mirror dengan `<mirrorOf>*</mirrorOf>`).
3. Untuk Go?

### Skenario C: Base Image Compromise

Cek apakah base image kedua app sudah di-pin ke digest:

```bash
grep -E "^FROM" sample-apps/hello-db/Dockerfile
grep -E "^FROM" sample-apps/payment-gateway/Dockerfile
```

Latihan: ubah `FROM golang:1.23-alpine` menjadi `FROM golang:1.23-alpine@sha256:<digest>`.

```bash
# Dapatkan digest saat ini
docker pull golang:1.23-alpine
docker inspect golang:1.23-alpine --format='{{index .RepoDigests 0}}'

# Dapatkan digest node:24-alpine
docker pull node:24-alpine
docker inspect node:24-alpine --format='{{index .RepoDigests 0}}'
```

Pertanyaan: apa risiko nyata bila tidak pakai digest? Berapa lama biasanya tag `node:24-alpine` mengarah ke image yang sama? (jawab: bisa berubah setiap patch release).

---

## Latihan 10 — Continuous Monitoring (Opsional, Butuh ~20 menit)

### Tujuan
Deploy OWASP Dependency-Track lokal, upload SBOM, lihat bagaimana notifikasi CVE baru bekerja.

### Langkah

Siapkan direktori kerja (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path $env:TEMP\dtrack | Out-Null
cd $env:TEMP\dtrack
```

Atau bash/WSL2/VPS:

```bash
mkdir -p /tmp/dtrack && cd /tmp/dtrack
```

Buat `docker-compose.yml` (sama di semua platform — edit dengan editor Windows biasa, atau heredoc di bash):

```yaml
services:
  apiserver:
    image: dependencytrack/apiserver:latest
    ports: ["8082:8080"]
    volumes: ["./data:/data"]
    deploy:
      resources:
        limits:
          memory: 4G
  frontend:
    image: dependencytrack/frontend:latest
    ports: ["8080:8080"]
    environment:
      API_BASE_URL: "http://localhost:8082"
```

Start:

```bash
docker compose up -d
# Tunggu ~2 menit — Dependency-Track startup lama (Java + H2/Postgres init)
docker compose logs -f apiserver | Select-String "Dependency-Track is ready"   # PowerShell
# atau: docker compose logs -f apiserver | grep -m1 "Dependency-Track is ready"  # bash
```

Alokasi memori Docker Desktop default di Windows sering 2 GB — Dependency-Track apiserver minta ≥4 GB. Naikkan di Docker Desktop → Settings → Resources → Memory ke 6 GB sebelum latihan ini.

Login ke `http://localhost:8080` (admin/admin, ganti password saat pertama login).

1. Buat project "payment-gateway" via UI.
2. Upload SBOM `out/sbom/payment-gateway.cdx.json` lewat web UI (paling mudah), atau REST API.

Bash/WSL2/VPS:

```bash
API_KEY="<paste-api-key>"
PROJECT_UUID="<from-UI>"

curl -X POST http://localhost:8082/api/v1/bom \
  -H "X-Api-Key: ${API_KEY}" \
  -H "Content-Type: multipart/form-data" \
  -F "project=${PROJECT_UUID}" \
  -F "bom=@out/sbom/payment-gateway.cdx.json"
```

PowerShell (Windows 10+ punya `curl.exe` bawaan, tapi alias `curl` berbenturan dengan `Invoke-WebRequest` — panggil eksplisit `curl.exe` atau pakai `Invoke-RestMethod`):

```powershell
$ApiKey = "<paste-api-key>"
$ProjectUuid = "<from-UI>"

curl.exe -X POST http://localhost:8082/api/v1/bom `
  -H "X-Api-Key: $ApiKey" `
  -H "Content-Type: multipart/form-data" `
  -F "project=$ProjectUuid" `
  -F "bom=@out/sbom/payment-gateway.cdx.json"
```

3. Tunggu ~1 menit, lihat dashboard — jumlah vulnerabilities muncul.
4. Setup Slack/email webhook: Administration → Notifications → Alerts → Create Alert (scope: `NEW_VULNERABILITY`).
5. Simulasi: update DB scanner (Administration → Vulnerability Sources → Force sync). CVE baru yang match SBOM akan trigger alert.

### Pertanyaan

1. Dependency-Track men-sync dari sumber apa saja secara default? (petunjuk: NVD, GHSA, OSS Index, Snyk bila dikonfigurasi).
2. Bedanya dengan hanya menjalankan `trivy sbom` harian via cron? (petunjuk: state, diffing, history, notifikasi granular, UI triage).

---

## Ringkasan Deliverable Latihan

Setelah selesai, trainee seharusnya punya:

- [ ] Laporan lint Hadolint + Dockle untuk kedua image.
- [ ] Report Trivy + Grype (JSON) untuk kedua image.
- [ ] Output `govulncheck` untuk `hello-db`.
- [ ] Output `npm audit` + `osv-scanner` untuk `payment-gateway`.
- [ ] File SBOM CycloneDX untuk kedua image di `out/sbom/`.
- [ ] Catatan triage minimal 1 CVE HIGH/CRITICAL: ID, komponen, KEV status, EPSS, reachability.
- [ ] Catatan perbandingan runtime test: baseline vs hardened — apa yang break, apa yang jalan.
- [ ] Catatan perbandingan hasil scan antara `hello-db` (scratch) vs `payment-gateway` (Alpine full), beserta penjelasan penyebabnya.

## Diskusi Penutup

1. Kalau harus memilih satu kontrol untuk diterapkan hari ini saja, mana yang berdampak terbesar: pin digest, SBOM + Dependency-Track, signing, atau runtime hardening? Kenapa?
2. Apa tradeoff `scratch` vs `alpine` dari sudut pandang operasional (debugging, incident response)?
3. CVE CRITICAL tanpa fix upstream (`--ignore-unfixed` menyembunyikannya) — bagaimana sikap yang tepat? Ignore selamanya? Track di ticket?
4. Insiden `tj-actions/changed-files` (Maret 2025) — bila tim kita pakai GitHub Actions, kontrol apa yang akan mencegah dampaknya?
