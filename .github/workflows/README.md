# GitHub Actions — Materi CI/CD

Folder ini berisi contoh workflow CI/CD untuk materi training:

| File                              | Tujuan                                                         |
|-----------------------------------|----------------------------------------------------------------|
| `deploy.yml`                      | Deploy `sample-apps/payment-gateway` (rsync + restart service) ke server training |
| `publish-payment-gateway.yml`     | Build Docker image multi-arch + push ke Docker Hub + GHCR       |

> **Catatan**: kedua workflow di sini **tidak aktif otomatis**. Repo ini
> adalah repo materi, bukan repo produksi. Fork peserta training tidak
> seharusnya memicu deployment / publishing ke akun instruktur.

## Pembagian Tanggung Jawab

| Tahap | Tools | Kapan Dijalankan |
|-------|-------|------------------|
| Provisioning server (install OS package, nginx, postgres, systemd unit, firewall, SELinux) | Ansible (`ansible-deploy/`) | Sekali saat server pertama dibangun, atau saat ada perubahan infrastruktur |
| Deploy aplikasi (rsync source, `npm install`, restart service) | GitHub Actions (`.github/workflows/deploy.yml`) | Setiap kali code aplikasi berubah |
| Publish Docker image ke registry | GitHub Actions (`.github/workflows/publish-payment-gateway.yml`) | Setiap kali mau rilis image baru (biasanya dipicu git tag) |

Pemisahan ini adalah pola umum di dunia SRE:

- **Ansible** untuk hal yang jarang berubah dan butuh akses root penuh.
- **CI/CD deploy** untuk hal yang sering berubah dan cukup butuh akses terbatas
  (rsync ke satu folder + restart satu service lewat `sudo` NOPASSWD
  yang di-whitelist).
- **CI/CD publish image** untuk membungkus aplikasi jadi artefak yang
  siap dijalankan di Kubernetes, ECS, atau compose di server lain.

## Alur Workflow `deploy.yml`

```
git push  ───►  GitHub Runner  ───►  SSH ke server target
                     │                      │
                     ├── checkout repo      ├── rsync source code
                     ├── npm ci (validasi)  ├── npm install --omit=dev
                     └── validasi config    ├── systemctl restart payment-gateway
                                            └── smoke test /api/health
```

## Alur Workflow `publish-payment-gateway.yml`

```
git push / tag  ───►  GitHub Runner  ───►  Registry (Docker Hub + GHCR)
                          │                         │
                          ├── checkout              ├── docker.io/endymuhardin/payment-gateway-js:<tag>
                          ├── setup QEMU            └── ghcr.io/endymuhardin/payment-gateway-js:<tag>
                          ├── setup Buildx
                          ├── login dockerhub       (tags dihasilkan otomatis oleh
                          ├── login ghcr             docker/metadata-action:
                          ├── extract meta            - latest (di default branch)
                          └── buildx build --push    - sha-<shortsha>
                                ↳ linux/amd64         - v1.2.3 + v1.2 + v1 (kalau push tag git)
                                ↳ linux/arm64)
```

**Secret yang dibutuhkan** (`Settings → Secrets and variables → Actions`):

| Secret | Isi | Cara dapat |
|--------|-----|------------|
| `DOCKERHUB_USERNAME` | username Docker Hub Anda | — |
| `DOCKERHUB_TOKEN` | access token (bukan password) | Docker Hub → Account Settings → Personal access tokens, scope: Read & Write |
| `GITHUB_TOKEN` | (otomatis) | disediakan runtime oleh GitHub, tidak perlu di-set |

GHCR tidak butuh secret manual — cukup `permissions: packages: write` yang
sudah di-declare di workflow. Image akan visible di
`https://github.com/users/<owner>/packages/container/payment-gateway-js`
setelah push pertama; default visibility **private** — ubah ke public
lewat Package settings kalau mau anyone bisa `docker pull`.

**Strategi tagging** (via `docker/metadata-action`):

| Event | Tag yang dihasilkan | Contoh |
|-------|---------------------|--------|
| push ke branch `main`         | `latest`, `main`, `sha-<short>` | `latest`, `main`, `sha-1a2b3c4` |
| push ke branch `feature/xxx`  | `feature-xxx`, `sha-<short>` | (di cabang, untuk QA) |
| push git tag `v1.2.3`         | `v1.2.3`, `1.2.3`, `1.2`, `1`, `sha-<short>` | semver tree — konsumen bisa pin di `:1` atau `:1.2` |

Tag `latest` **hanya** di-update saat default branch (main) — push tag
git `v1.2.3` tidak otomatis update `latest`, harus dilakukan dari main.

## Kenapa Tidak Aktif di Repo Ini

Ada dua alasan teknis:

### 1. Secrets tidak di-set

Workflow butuh secret berikut:

| Secret | Isi |
|--------|-----|
| `DEPLOY_HOST` | hostname / IP server target |
| `DEPLOY_USER` | user SSH di server (misal `azureuser`) |
| `DEPLOY_SSH_KEY` | private key SSH (matching public key sudah di `authorized_keys` user di atas) |
| `DEPLOY_SSH_PORT` | (opsional) port SSH, default 22 |

Di repo materi ini kita tidak mau commit path atau key yang spesifik ke
satu server. Jadi secrets dibiarkan kosong dan step `Require deploy secrets`
akan gagal dengan pesan `::error::secret 'X' is not set` — ini sengaja,
supaya peserta tahu apa yang kurang kalau mau coba di lingkungan mereka.

### 2. Server training biasanya di private network

Lihat `ansible-deploy/inventory/development.ini`: target IP-nya
`10.0.120.6` — alamat RFC1918. Runner GitHub-hosted (`ubuntu-latest`)
ada di cloud Microsoft/Azure dan **tidak punya route** ke private
subnet Anda. Supaya runner bisa sampai ke server, Anda butuh salah satu:

| Opsi | Cocok Untuk | Catatan |
|------|-------------|---------|
| Public IP + SSH terbuka (port 22 / non-standar) | Lab pribadi, server cloud dengan public interface | Kombinasikan dengan `fail2ban` + IP allowlist GitHub |
| [Tailscale GitHub Action](https://github.com/tailscale/github-action) | Pilihan paling simpel untuk mayoritas kasus | Free tier: 100 devices, 3 users. Runner join tailnet sebagai ephemeral node |
| Cloudflare Tunnel + `cloudflared access ssh` | Sudah pakai Cloudflare | Zero-trust tunnel, tidak perlu public IP |
| Self-hosted runner di network yang sama | Compliance ketat, server benar-benar isolated | Runner jadi bagian dari infra target, bukan GitHub cloud |
| OpenVPN client di runner | Sudah punya VPN concentrator | Cert/management overhead, startup ~2-5 detik per run |

## Cara Mengaktifkan di Lingkungan Anda Sendiri

1. Fork repo ini ke organisasi / akun Anda sendiri.
2. **Provisioning**: jalankan playbook Ansible di `ansible-deploy/` ke
   server target Anda.
   ```bash
   cd ansible-deploy
   ansible-playbook playbooks/site.yml
   ```
   Role `nodejs_app` akan menyiapkan direktori, systemd unit, nginx
   proxy, dan sudoers rule yang mengizinkan user deploy untuk
   `systemctl restart payment-gateway` tanpa password.
3. **Secrets**: buat 3 secret di `Settings → Secrets and variables → Actions`:
   `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.
4. **Reachability**: pilih salah satu opsi di tabel di atas. Kalau pakai
   Tailscale, tambahkan step `tailscale/github-action@v3` sebelum step
   `Configure SSH`.
5. **Aktifkan trigger push**: edit `.github/workflows/deploy.yml`,
   tambahkan blok berikut di bagian `on:`:
   ```yaml
   push:
     branches: [main]
     paths:
       - 'sample-apps/payment-gateway/**'
       - '.github/workflows/deploy.yml'
   ```
   Commit. Push berikutnya ke `main` akan langsung memicu deploy.
6. Kalau ingin coba manual tanpa push: tab **Actions → Deploy Payment
   Gateway → Run workflow**.

### Mengaktifkan `publish-payment-gateway.yml`

1. Buat 2 secret di repo:
   - `DOCKERHUB_USERNAME`
   - `DOCKERHUB_TOKEN` (dari Docker Hub Account Settings → Personal access tokens)
2. Ganti `DOCKERHUB_IMAGE` / `GHCR_IMAGE` di workflow kalau Anda mau publish
   ke akun berbeda (`endymuhardin/...` → `<akun anda>/...`).
3. (Opsional) Aktifkan trigger `push` dengan uncomment blok di file
   workflow. Biasanya publish dipicu oleh **git tag** (bukan tiap commit
   ke main) supaya image version-tagged sesuai release:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
4. Jalankan manual: tab **Actions → Publish payment-gateway image → Run workflow**.
5. Cek hasil di Docker Hub dan GHCR packages tab repo GitHub.

## Materi Diskusi di Kelas

Pertanyaan yang bagus untuk didiskusikan peserta setelah membaca
workflow dan role Ansible yang sudah ditrim:

1. Apa risiko kalau CI/CD user punya `NOPASSWD: ALL` di sudoers vs
   hanya whitelist `systemctl restart payment-gateway`?
2. Kalau `npm install` di server memakan 60 detik, bagaimana cara
   mengurangi downtime saat restart? (hint: blue/green, `npm ci` dengan
   cache, dependency pre-build artifact)
3. Smoke test di workflow hanya memanggil `/api/health`. Apa saja yang
   **tidak** ketangkap oleh smoke test seperti ini? Bagaimana
   memperbaikinya?
4. Kalau deploy gagal di tengah (rsync sukses, tapi service tidak
   mau start), bagaimana cara rollback otomatis? Struktur direktori
   seperti apa yang mendukung ini (lihat: Capistrano-style `releases/`
   + symlink `current`)?
5. Fork ini adalah repo publik. Apa yang terjadi kalau ada contributor
   eksternal yang membuka Pull Request yang mengubah workflow? Apakah
   secrets bocor? (hint: trigger `pull_request` dari fork tidak dapat
   akses ke secrets — tapi `pull_request_target` bisa, dan itu
   berbahaya.)
