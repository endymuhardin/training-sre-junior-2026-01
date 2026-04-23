# Server Hardening & Supply Chain Security

Materi pendukung Hari 4 — Basic Hardening.

---

## Bagian 1: Server Hardening

### Konsep Dasar

Server hardening adalah proses mengurangi *attack surface* (permukaan serangan) sebuah server dengan cara:

- Menghapus/menonaktifkan komponen yang tidak diperlukan (service, user, paket).
- Mengunci konfigurasi default yang permisif.
- Menerapkan *least privilege* untuk user, proses, dan service.
- Menambahkan lapisan pertahanan (firewall, MAC, audit logging).

Prinsipnya: **setiap komponen yang terpasang dan berjalan adalah potensi celah**. Kalau tidak dipakai, matikan atau hapus.

### Layer Hardening

Hardening bukan satu tindakan, melainkan serangkaian tindakan di beberapa layer:

| Layer | Contoh Hardening |
|---|---|
| BIOS/Firmware | Password BIOS, Secure Boot, disable USB boot |
| Kernel & OS | Update patch, kernel parameter (sysctl), disable module tidak dipakai |
| Filesystem | Mount option (`noexec`, `nosuid`, `nodev`), file permission |
| Network | Firewall (nftables/iptables/ufw), disable service tidak dipakai, port filtering |
| Authentication | SSH key only, MFA, password policy, disable root login |
| Application | Run as non-root, resource limit, seccomp/AppArmor/SELinux profile |
| Audit & Log | auditd, log forwarding, file integrity monitoring |

### Checklist Server Hardening (Linux)

#### A. User & Authentication

- [ ] Nonaktifkan login root via SSH: `PermitRootLogin no` di `/etc/ssh/sshd_config`.
- [ ] Gunakan SSH key, matikan password authentication: `PasswordAuthentication no`.
- [ ] Ganti port SSH default 22 ke port non-standar (mengurangi noise brute force).
- [ ] Batasi user yang boleh SSH: `AllowUsers` atau `AllowGroups`.
- [ ] Set session timeout SSH: `ClientAliveInterval 300`, `ClientAliveCountMax 2`.
- [ ] Terapkan password policy via `pam_pwquality` (minimal panjang, kompleksitas).
- [ ] Nonaktifkan user default yang tidak dipakai (`games`, `news`, dll).
- [ ] Set `umask 027` atau `077` di `/etc/login.defs` untuk default permission lebih ketat.
- [ ] Audit file `/etc/passwd`, `/etc/shadow`, `/etc/group` — pastikan tidak ada UID 0 selain root.
- [ ] Pasang `fail2ban` untuk blok IP yang gagal login berulang.

#### B. Paket & Service

- [ ] Update sistem: `apt upgrade` / `dnf update` — pastikan kernel dan library terbaru.
- [ ] Aktifkan `unattended-upgrades` untuk security patch otomatis.
- [ ] Uninstall paket yang tidak dipakai: compiler, X server, mail server lokal.
- [ ] Disable service yang tidak dipakai: `systemctl disable --now <service>`.
- [ ] Audit service listening: `ss -tlnp` — matikan yang tidak perlu.
- [ ] Gunakan official repository, verifikasi GPG signature.

#### C. Network & Firewall

- [ ] Enable firewall (nftables/ufw/firewalld), default policy DROP untuk INPUT.
- [ ] Hanya buka port yang diperlukan (80, 443, SSH custom port).
- [ ] Gunakan *rate limiting* di firewall untuk port SSH dan API publik.
- [ ] Disable ICMP redirects: `net.ipv4.conf.all.accept_redirects = 0`.
- [ ] Enable SYN cookies: `net.ipv4.tcp_syncookies = 1`.
- [ ] Disable IP forwarding bila bukan router: `net.ipv4.ip_forward = 0`.
- [ ] Disable IPv6 bila tidak dipakai untuk mengurangi attack surface.

#### D. Filesystem & Permission

- [ ] Mount `/tmp`, `/var/tmp`, `/dev/shm` dengan `noexec,nosuid,nodev`.
- [ ] Partisi terpisah untuk `/var`, `/var/log`, `/home` untuk mencegah DoS via disk full.
- [ ] Scan file dengan SUID/SGID: `find / -perm /6000 -type f` — review tiap entry.
- [ ] Cari world-writable: `find / -perm -002 -type f`.
- [ ] Proteksi file sensitif: `chmod 600 /etc/shadow`, `chmod 600 /root/.ssh/authorized_keys`.
- [ ] Aktifkan *sticky bit* untuk shared directory.

#### E. Kernel Hardening (sysctl)

```
# /etc/sysctl.d/99-hardening.conf
kernel.randomize_va_space = 2
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
fs.suid_dumpable = 0
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
```

#### F. Mandatory Access Control

- [ ] Aktifkan SELinux (`enforcing`) di RHEL/Rocky/Alma atau AppArmor di Debian/Ubuntu.
- [ ] Jangan disable MAC — tulis policy yang benar, bukan matikan.
- [ ] Review denial log: `ausearch -m AVC` atau `journalctl | grep apparmor`.

#### G. Audit & Logging

- [ ] Pasang `auditd` dan konfigurasi rules untuk file sensitif (`/etc/passwd`, `/etc/sudoers`, binary kritis).
- [ ] Forward log ke central log server (syslog, Loki, ELK) — log lokal bisa dihapus attacker.
- [ ] File integrity monitoring: AIDE, Tripwire, atau Wazuh.
- [ ] Monitor login: `last`, `lastb`, `journalctl _SYSTEMD_UNIT=ssh.service`.
- [ ] Set log retention yang cukup (minimal 90 hari untuk audit trail).

#### H. Application Runtime

- [ ] Jalankan aplikasi sebagai user non-root (systemd `User=`, Docker `USER`).
- [ ] Set resource limit via systemd: `MemoryMax`, `CPUQuota`, `TasksMax`.
- [ ] Isolasi via systemd unit: `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `NoNewPrivileges=true`.
- [ ] Untuk container: drop semua capability, tambahkan hanya yang perlu (`--cap-drop=ALL --cap-add=NET_BIND_SERVICE`).
- [ ] Jangan mount Docker socket ke dalam container sembarangan.
- [ ] Scan image dengan Trivy/Grype sebelum deploy.

#### I. Backup & Recovery

- [ ] Backup konfigurasi `/etc`, data aplikasi, database — terjadwal dan terenkripsi.
- [ ] Simpan backup di lokasi terpisah (offsite/object storage).
- [ ] Test restore secara berkala — backup yang tidak pernah di-restore statusnya *unknown*, bukan *works*.

### Tools Bantu Hardening

| Tool | Fungsi |
|---|---|
| Lynis | Audit hardening Linux, memberi skor dan rekomendasi |
| OpenSCAP | Compliance scan (CIS, STIG, PCI-DSS) |
| CIS-CAT | Scanner resmi CIS Benchmark |
| Ansible + dev-sec.hardening | Otomasi hardening via role Ansible |
| Wazuh | FIM, log analysis, compliance monitoring |
| auditd + aureport | Kernel audit subsystem Linux |

---

## Bagian 2: Supply Chain Security

### Konsep Dasar

*Software supply chain* adalah seluruh rantai komponen pihak ketiga yang masuk ke aplikasi: library, base image, build tool, CI/CD plugin, registry, transitive dependency.

Supply chain attack = attacker kompromikan salah satu komponen di rantai tersebut. Kode berbahaya masuk ke produksi lewat pintu yang dipercaya (dependency yang di-`install`, image yang di-`pull`, action yang di-`uses`), sehingga bypass review kode internal.

Tingkat risikonya besar karena:

- Satu library populer bisa dipakai jutaan project (blast radius besar).
- Transitive dependency — developer sering tidak tahu project mereka menarik library X.
- Build time & runtime trust boundary lemah — developer jarang baca kode dependency.

### Kategori Serangan

1. **Typosquatting** — paket dengan nama mirip populer (`reqeusts` vs `requests`).
2. **Dependency confusion** — attacker publish paket dengan nama internal ke public registry, build system prioritaskan public.
3. **Maintainer compromise** — akun maintainer asli diambil alih (phishing, kredensial bocor, token npm/pypi curi).
4. **Malicious update / protestware** — maintainer asli dengan sengaja masukkan kode merusak.
5. **Build system compromise** — CI runner, build tool, atau pipeline disusupi.
6. **Transitive injection** — paket legit menarik paket lain yang sudah dikompromi.

### Case Study Terbaru

#### Node.js / npm

- **event-stream (2018)** — Maintainer serahkan akses ke kontributor baru yang lalu menambahkan paket `flatmap-stream` berisi kode mencuri Bitcoin wallet dari aplikasi Copay. Jadi contoh klasik *maintainer handoff attack*.
- **ua-parser-js (2021)** — Akun maintainer diretas, tiga versi paket di-publish dengan miner + credential stealer. Paket ini di-download ~8 juta kali per minggu.
- **colors.js & faker.js (Januari 2022)** — Maintainer asli (Marak Squires) sengaja push infinite loop — *protestware*. Ribuan aplikasi production crash.
- **node-ipc (Maret 2022)** — Maintainer tambahkan kode yang menghapus file di mesin dengan IP Rusia/Belarus — protestware dengan payload destruktif.
- **ctx & phpass (Mei 2022)** — Paket legit yang sudah lama *unmaintained* diambil alih (expired domain email maintainer), lalu versi baru berisi infostealer di-publish.
- **Polyfill.io (Juni 2024)** — Domain `cdn.polyfill.io` dibeli perusahaan baru (Funnull), lalu melayani malicious script ke ~100.000+ website yang masih pakai CDN tersebut. Menggambarkan risiko *transitive runtime dependency* via CDN/script tag.
- **tj-actions/changed-files (Maret 2025)** — GitHub Action populer dikompromi. Tag diarahkan ke commit yang *dump* secret dari runner. Attacker akhirnya leak token dari ribuan repo. Root cause: GitHub Action di-referensikan dengan tag (mutable) bukan commit SHA (immutable).

#### Java / Maven Central

- **Log4Shell / CVE-2021-44228 (Desember 2021)** — Bukan supply chain attack murni (bug bukan malicious code), tapi menunjukkan *blast radius* dependency Java: satu vulnerability di `log4j-core` memengaruhi ribuan produk enterprise. Insiden ini mempercepat adopsi SBOM dan SCA.
- **Dependency confusion di ekosistem enterprise Java (2021-)** — Alex Birsan mendemonstrasikan dependency confusion pada internal package dari perusahaan besar (termasuk Apple, Microsoft, PayPal). Pada Maven, serangan muncul ketika `settings.xml` salah konfigurasi — mirror public Maven Central ditaruh sebelum private Nexus/Artifactory.
- **jackson-databind (berkelanjutan)** — Serangkaian RCE via deserialization di gadget class. Bukan paket jahat, tapi menegaskan bahwa dependency legit yang tidak di-*patch* = supply chain risk.
- **Spring4Shell / CVE-2022-22965 (Maret 2022)** — RCE di Spring Framework, mirip Log4Shell dari sisi dampak supply chain.
- **XZ Utils / CVE-2024-3094 (Maret 2024)** — *Bukan* Java, tetapi kasus paling dalam sampai hari ini. Maintainer "Jia Tan" menyusup ke project `xz` selama 2+ tahun, lalu menyisipkan backdoor di `liblzma` yang di-*link* oleh `sshd` (via patch distro). Dampak ke JVM: banyak container base image (Alpine, Debian) terpapar sebelum patch. Relevan untuk Java karena base image container Java umumnya berbasis distro tersebut.

#### Go / Go Modules

- **Typosquatting di `pkg.go.dev`** — Banyak laporan paket dengan nama mirip paket populer (`githib.com/...`, `github.com/aws/aws-sdk-go` vs variasi). Go module namespace sebetulnya lebih aman (berbasis URL repo), tapi typosquat di GitHub organization tetap mungkin.
- **Malicious Go modules via GitHub (2023-2024)** — Beberapa paket di GitHub bernama mirip project legit, setelah `go get`, pada `init()` men-*download* payload dari C2. Checkmarx dan Socket memublikasikan puluhan contoh.
- **Compromise build via `go generate`** — `go generate` menjalankan perintah arbitrary di build time. Jika dependency menaruh `//go:generate curl ... | sh`, build-mu mengeksekusi kode attacker. Praktik mitigasi: jangan jalankan `go generate` pada kode pihak ketiga.
- **GOPROXY poisoning** — Bila proxy Go internal tidak verifikasi checksum (`GOSUMDB` dimatikan), modifikasi modul di cache bisa lolos. Selalu biarkan `GOSUMDB=sum.golang.org` aktif.

### Mitigasi — Secara Umum

1. **Lock & pin versi**
   - Node.js: commit `package-lock.json` atau `pnpm-lock.yaml`, pakai `npm ci` di CI (bukan `npm install`).
   - Java/Maven: commit `pom.xml` dengan versi eksplisit, hindari `LATEST`/`RELEASE`. Pertimbangkan `dependencyManagement` + `enforcer-plugin` untuk cegah konflik versi.
   - Go: `go.mod` + `go.sum` wajib di-commit. Biarkan `GOSUMDB` aktif.

2. **Verifikasi integritas**
   - Gunakan checksum / hash (npm `integrity`, Maven `checksums`, Go `go.sum`).
   - Untuk container: *pin image* ke digest (`image@sha256:...`) bukan tag (`:latest`).
   - Untuk GitHub Actions: *pin* ke commit SHA (`uses: actions/checkout@<40-char-sha>`) bukan ke tag.

3. **Review dependency baru**
   - Cek umur paket, jumlah maintainer, aktivitas repo, jumlah download.
   - Paket baru dari maintainer tanpa track record = red flag.
   - Gunakan `npm audit`, `yarn audit`, `mvn dependency:tree`, `go list -m all` untuk inventarisasi.

4. **Minimalisasi dependency**
   - Bukan semua utility kecil perlu jadi library. `is-odd`, `left-pad` style dependency adalah hutang supply chain.
   - Tree-shaking & review transitive dep.

5. **Isolasi build environment**
   - Build di CI yang ephemeral (container sekali pakai).
   - Jangan jalankan build dengan secret yang tidak diperlukan untuk build.
   - Batasi network egress dari build runner — hanya ke registry yang sah.

6. **Private registry / mirror**
   - Gunakan Nexus, Artifactory, Verdaccio, atau Go module proxy internal.
   - Pull-through cache mengurangi risiko paket hilang (left-pad style) sekaligus memberi titik untuk scanning.
   - Konfigurasikan *namespace scoping* agar internal package tidak pernah jatuh ke public registry (hindari dependency confusion).

7. **SBOM (Software Bill of Materials)**
   - Generate SBOM per build (CycloneDX atau SPDX).
   - Simpan SBOM bersamaan dengan artifact — ketika ada CVE baru muncul, kamu bisa query SBOM untuk tahu apakah kamu terdampak.

8. **Signing & provenance**
   - Sign artifact dengan Sigstore/cosign.
   - SLSA (Supply-chain Levels for Software Artifacts) provenance attestation — bukti build berasal dari source & builder yang diketahui.
   - Verifikasi signature di *admission controller* (Kubernetes dengan Kyverno/Connaisseur).

### Tools untuk CI/CD

#### Dependency Scanning (SCA)

| Tool | Ekosistem | Catatan |
|---|---|---|
| OWASP Dependency-Check | Java, .NET, Node, Python | NVD-based, bisa jalan di Maven/Gradle plugin |
| Snyk | Multi-language | SaaS, punya auto-fix PR |
| GitHub Dependabot | Multi-language | Built-in GitHub, buat PR upgrade otomatis |
| Renovate | Multi-language | Self-hosted-able, config lebih fleksibel dari Dependabot |
| Trivy | Container, filesystem, git repo, SBOM | Open source, cepat, juga scan IaC |
| Grype | Container, filesystem, SBOM | Open source dari Anchore |
| OSV-Scanner | Multi-language | Dari Google, pakai OSV database |
| Socket | npm, PyPI, Go | Mendeteksi perilaku mencurigakan (bukan hanya CVE) — install hooks, network call, eval |

#### SBOM Generation

| Tool | Fungsi |
|---|---|
| Syft | Generate SBOM (CycloneDX/SPDX) dari image/filesystem/repo |
| CycloneDX Maven/Gradle Plugin | SBOM untuk project Java |
| `npm sbom` (npm 10+) | SBOM native npm |
| `cyclonedx-gomod` | SBOM untuk Go module |

#### Signing & Provenance

| Tool | Fungsi |
|---|---|
| cosign (Sigstore) | Sign & verify container image, blob, SBOM |
| slsa-github-generator | Generate SLSA provenance dari GitHub Actions |
| in-toto | Framework attestation supply chain |
| Kyverno / Connaisseur | Admission controller Kubernetes untuk verifikasi signature |

#### Secret Scanning

| Tool | Fungsi |
|---|---|
| gitleaks | Scan secret di git history |
| trufflehog | Scan secret, verifikasi validitas token |
| GitHub secret scanning | Built-in untuk repo publik & Advanced Security |

#### Static Analysis & Policy

| Tool | Fungsi |
|---|---|
| Semgrep | SAST rule-based, cepat, support policy as code |
| CodeQL | SAST GitHub, query language kuat |
| OPA / Conftest | Policy engine, sering dipakai untuk gating CI |

### Contoh Pipeline CI/CD yang "Supply-Chain Aware"

Urutan idealnya (konsep, bukan tool spesifik):

1. **Checkout source** — pin action ke commit SHA.
2. **Restore lockfile cache** — hanya boleh cache lockfile yang sama dengan commit.
3. **Install dependency** — gunakan mode strict (`npm ci`, `mvn -B --no-transfer-progress`, `go mod download`) dari private mirror.
4. **SAST scan** — Semgrep/CodeQL terhadap source.
5. **SCA scan** — Trivy/Dependency-Check terhadap lockfile. Fail build bila ada CVE critical.
6. **Secret scan** — gitleaks terhadap commit range.
7. **Build artifact** — di runner ephemeral.
8. **Generate SBOM** — Syft → simpan bersama artifact.
9. **Sign artifact** — cosign dengan keyless signing (OIDC dari CI).
10. **Generate SLSA provenance** — kaitkan artifact ke commit & builder.
11. **Push ke registry internal** — registry yang enforce signature pada `push`.
12. **Deploy** — admission controller verifikasi signature & provenance sebelum jalankan pod.

### Tanda-Tanda Paket Mencurigakan (Quick Checklist Review)

- Paket baru (umur < 3 bulan) dengan downloads tinggi tiba-tiba.
- Maintainer tunggal tanpa profil publik, atau akun yang baru dibuat.
- Install script (`preinstall`/`postinstall` di npm, `setup.py` di Python) yang melakukan network call.
- Dependency menarik binary dari URL saat install.
- Minified/obfuscated code di dalam source yang seharusnya plaintext.
- Kode yang membaca `process.env`, `~/.aws/credentials`, `~/.ssh/`, `~/.npmrc`.
- Perubahan mendadak di *release cadence* (paket stabil 3 tahun, tiba-tiba 5 release dalam seminggu).

---

## Bagian 3: Docker Image Security

Docker image security adalah irisan antara hardening (build-time, runtime) dan supply chain (base image, layer). Image yang sudah jadi adalah artifact yang akan dieksekusi di produksi — ukurannya, isinya, asal-usulnya, dan cara menjalankannya semua jadi attack surface.

### Model Ancaman Container

| Vektor | Contoh |
|---|---|
| Base image kompromi | Base image dari Docker Hub dengan cryptominer / backdoor |
| Layer berisi secret | `.env`, private key, `.git`, `~/.aws/credentials` tercopy ke image |
| CVE di OS package | `openssl`, `glibc`, `curl` versi lama di base image |
| CVE di runtime app | Library app (log4j, jackson, express) versi rentan |
| Misconfigurasi runtime | Container jalan sebagai root, `--privileged`, mount docker.sock |
| Registry tidak dipercaya | Pull dari registry publik tanpa verifikasi signature |
| Build cache poisoning | CI pakai cache shared yang sudah terkontaminasi |

### Dockerfile Hardening Checklist

#### A. Pilihan Base Image

- [ ] Pakai base image minimal: `distroless`, `alpine`, `chainguard`, atau `wolfi` — semakin kecil, semakin sedikit CVE.
- [ ] Pin image ke digest, bukan tag: `FROM eclipse-temurin:21-jre@sha256:abcd1234...`. Tag mutable — maintainer bisa rewrite.
- [ ] Hindari `:latest` di semua konteks (build, FROM, pull).
- [ ] Pilih *official image* atau *verified publisher* di Docker Hub, atau mirror internal.
- [ ] Untuk Java: pertimbangkan `eclipse-temurin`, `amazoncorretto`, atau `chainguard/jre` daripada `openjdk` (deprecated di Docker Hub).
- [ ] Untuk Node.js: `node:<version>-slim` atau `node:<version>-alpine`; lebih baik `gcr.io/distroless/nodejs` untuk runtime.
- [ ] Untuk Go: build di `golang:<version>` multi-stage, jalankan di `scratch` atau `distroless/static`.

#### B. Multi-Stage Build

Tujuan: build-time tooling (compiler, package manager, dev header) tidak ikut ke runtime image.

```dockerfile
# Stage 1: build
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app ./cmd/app

# Stage 2: runtime
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

Dampak: runtime image hanya berisi 1 binary statis + certs. Tidak ada shell, tidak ada `apt`, tidak ada `curl` — attacker yang dapat RCE pun sulit lakukan lateral movement.

#### C. User & Permission

- [ ] **Jangan jalankan sebagai root.** Tambahkan `USER` non-root di Dockerfile.
- [ ] Untuk image yang butuh bind port < 1024: gunakan `NET_BIND_SERVICE` capability atau redirect port di reverse proxy — jangan run as root.
- [ ] Set file ownership eksplisit: `COPY --chown=app:app ./dist /app`.
- [ ] Readonly root filesystem di runtime: `docker run --read-only`, untuk file tulis pakai volume.

#### D. Konten Image

- [ ] Gunakan `.dockerignore` untuk exclude `.git`, `node_modules`, `.env`, `*.key`, `target/`, `dist/` yang tidak perlu.
- [ ] Jangan `COPY . .` tanpa `.dockerignore`. Sering kali `.git` dan kredensial ikut tercopy.
- [ ] Jangan `ARG` untuk password/token — value `ARG` terekam di history layer dan bisa dibaca siapapun yang `docker history`.
- [ ] Untuk secret saat build, pakai BuildKit secret mount: `RUN --mount=type=secret,id=npmrc npm ci`.
- [ ] Bersihkan package manager cache di layer yang sama dengan install:
  ```dockerfile
  RUN apt-get update && apt-get install -y --no-install-recommends curl \
      && rm -rf /var/lib/apt/lists/*
  ```
- [ ] Pin versi package OS: `apt-get install -y curl=7.88.1-*`.
- [ ] Jangan install tool debugging di image produksi: `curl`, `wget`, `bash`, `sh`, `ping`, `netcat`. Distroless menghilangkan ini by default.

#### E. Metadata & Reproducibility

- [ ] Tambahkan `LABEL` OCI standard: `org.opencontainers.image.source`, `.revision`, `.version`, `.created`.
- [ ] Set `SOURCE_DATE_EPOCH` agar build reproducible (timestamp layer konsisten).
- [ ] Gunakan `HEALTHCHECK` untuk liveness, atau tangani dari orkestrator (Kubernetes probe lebih fleksibel).

### Runtime Hardening Checklist

Saat `docker run` / di `docker-compose.yml` / di Kubernetes manifest:

- [ ] `--user <uid>:<gid>` (non-root, meski Dockerfile sudah set — defense in depth).
- [ ] `--read-only` untuk root filesystem.
- [ ] `--cap-drop=ALL`, tambahkan hanya capability yang dibutuhkan.
- [ ] `--security-opt=no-new-privileges` — mencegah escalation via setuid binary.
- [ ] `--security-opt seccomp=<profile.json>` — default Docker sudah cukup; jangan `--privileged`.
- [ ] `--security-opt apparmor=<profile>` (atau SELinux context).
- [ ] Resource limit: `--memory`, `--cpus`, `--pids-limit`.
- [ ] `tmpfs` untuk direktori writable yang ephemeral: `--tmpfs /tmp:rw,noexec,nosuid,size=64m`.
- [ ] **Jangan** `--privileged`. Hampir tidak pernah diperlukan di produksi.
- [ ] **Jangan** mount `/var/run/docker.sock` ke container app — itu setara memberi root host.
- [ ] **Jangan** mount `/` host atau `/etc` host ke container.
- [ ] Jaringan: gunakan user-defined bridge, bukan `--network=host` kecuali benar-benar perlu.

Ekivalen Kubernetes (pod spec):

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

### Image Scanning

Lakukan scan di dua titik:

1. **CI (pre-push)** — fail build bila ada CVE `CRITICAL` / `HIGH` baru.
2. **Registry (continuous)** — scan ulang berkala, karena CVE baru muncul setelah image di-push.

| Tool | Kelebihan |
|---|---|
| Trivy | Scan image, filesystem, git, IaC, SBOM. Cepat, open source. |
| Grype | Dari Anchore, database Syft SBOM. |
| Docker Scout | Terintegrasi di Docker Desktop/CLI, policy & comparison antar tag. |
| Clair | Engine untuk Harbor & registry lain. |
| Snyk Container | SaaS, saran fix base image. |
| Harbor | Registry yang built-in scan (Trivy), image signing, replication. |

Contoh CI step:
```bash
trivy image --severity CRITICAL,HIGH --exit-code 1 --ignore-unfixed myapp:${SHA}
```

`--ignore-unfixed` penting: fokuskan ke CVE yang sudah ada patch-nya — sisanya hanya noise sampai upstream rilis fix.

### Image Signing & Verifikasi

Tanpa signature, `docker pull` hanya percaya registry. Kalau registry atau akun CI dikompromi, image jahat bisa menggantikan image sah dengan nama yang sama (terutama pada tag mutable).

Alur dengan Sigstore `cosign`:

```bash
# Sign (di CI, keyless dengan OIDC)
cosign sign --yes registry.example.com/app@sha256:<digest>

# Verify (di admission controller atau pre-deploy)
cosign verify \
  --certificate-identity-regexp "https://github.com/myorg/.*" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  registry.example.com/app@sha256:<digest>
```

Di Kubernetes, enforce verifikasi pakai:
- **Kyverno** — policy-based, bisa mewajibkan `image.signed = true` sebelum Pod dijadwalkan.
- **Connaisseur** — admission controller khusus signature.
- **Sigstore Policy Controller** — dari project Sigstore.

### SBOM untuk Container Image

```bash
# Generate SBOM (CycloneDX)
syft registry.example.com/app:1.2.3 -o cyclonedx-json > app-1.2.3.sbom.json

# Attach ke image sebagai attestation
cosign attest --predicate app-1.2.3.sbom.json \
  --type cyclonedx \
  registry.example.com/app@sha256:<digest>
```

Manfaat: saat CVE baru rilis (misal CVE berikutnya pada `libxml2`), kamu bisa query seluruh SBOM di registry untuk tahu image mana yang terdampak — tanpa harus scan ulang semua image.

### Registry Security

- [ ] Gunakan registry private (Harbor, Artifactory, ECR, GAR, GHCR private).
- [ ] Aktifkan vulnerability scanning di registry.
- [ ] Aktifkan content trust / image signing enforcement.
- [ ] Rotasi credential/token secara berkala.
- [ ] Batasi siapa yang boleh push (robot account per-repo, bukan shared admin).
- [ ] Enable immutable tag — mencegah attacker overwrite tag yang sudah ada.
- [ ] Scan ulang image lama — CVE baru di image lama adalah risiko yang sering terlupa.
- [ ] Retention policy — hapus image lama/untagged agar tidak jadi zombie artifact.

### Case Study Container

- **Docker Hub typosquatting (berkelanjutan)** — Image dengan nama mirip official (`alpime`, `nodee`, `mysqll`) menyembunyikan cryptominer. Sybil attack dengan ratusan akun.
- **Alpine `apk` root CVE-2021-36159** — Bug di libfetch yang dipakai `apk` memungkinkan MITM saat `apk add`. Perkuat argumen: pin base image digest + build di jaringan terpercaya.
- **Docker Hub cryptominer images (2020-2023)** — Palo Alto Unit 42 dan Sysdig menemukan ribuan image publik berisi XMRig. Target: developer yang cari image "test" / "demo" / "hacking" dan jalankan langsung.
- **Log4Shell di container** — CVE-2021-44228 menyerang image berbasis Java yang shipping `log4j-core` ≥2.0 <2.17. Insiden ini memperlihatkan pentingnya scanning berkelanjutan: image yang dibangun kemarin bisa jadi *vulnerable* besok.
- **XZ Utils backdoor (Maret 2024)** — `liblzma` yang ter-linked ke `sshd` via patch distro. Banyak base image populer (Debian testing, Fedora rawhide, Alpine edge) memuat versi yang terpapar sebelum patch. Mitigasi nyata: pin ke *stable channel* + scan regular + konsumsi security advisory distro.
- **Polyfill.io via container** — Banyak image frontend men-*bake* `<script src="cdn.polyfill.io/...">` ke dalam build. Ketika domain berpindah tangan, image-image tersebut langsung melayani malicious JS ke user akhir. Pelajaran: *runtime third-party dependency* (CDN) juga bagian supply chain container.

### Contoh Pipeline CI/CD Khusus Container

```
1. docker buildx build --platform linux/amd64 -t app:${SHA} .
2. trivy image --severity CRITICAL,HIGH --ignore-unfixed --exit-code 1 app:${SHA}
3. syft app:${SHA} -o cyclonedx-json > app-${SHA}.sbom.json
4. docker tag app:${SHA} registry.example.com/app:${SHA}
5. docker push registry.example.com/app:${SHA}
6. DIGEST=$(crane digest registry.example.com/app:${SHA})
7. cosign sign --yes registry.example.com/app@${DIGEST}
8. cosign attest --predicate app-${SHA}.sbom.json --type cyclonedx registry.example.com/app@${DIGEST}
9. cosign verify ... (pre-deploy, dan juga di admission controller)
10. Deploy dengan image reference ke @${DIGEST}, bukan :${SHA}
```

### Tools Ringkas

| Tool | Kategori |
|---|---|
| Trivy / Grype / Docker Scout / Clair | Image vulnerability scan |
| Syft | SBOM generator |
| cosign | Signing & verification |
| Dockle | Linter Dockerfile & image (CIS Docker Benchmark) |
| Hadolint | Linter Dockerfile syntax & best practice |
| docker-bench-security | Audit host Docker terhadap CIS Benchmark |
| Falco | Runtime threat detection untuk container |
| Tetragon | eBPF-based runtime observability & enforcement |
| Kyverno / OPA Gatekeeper | Admission control Kubernetes |
| Harbor | Registry dengan scan + signing built-in |

### Bacaan Lanjutan

- SLSA Framework: https://slsa.dev
- OWASP Top 10 CI/CD Security Risks: https://owasp.org/www-project-top-10-ci-cd-security-risks/
- OpenSSF Scorecard: https://scorecard.dev
- CIS Benchmarks: https://www.cisecurity.org/cis-benchmarks
- Sigstore: https://www.sigstore.dev
- CIS Docker Benchmark: https://www.cisecurity.org/benchmark/docker
- NIST SP 800-190 Application Container Security Guide: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-190.pdf
- Distroless images: https://github.com/GoogleContainerTools/distroless
- Chainguard Images: https://images.chainguard.dev
