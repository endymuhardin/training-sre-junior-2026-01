# GitHub Actions — Materi Deployment

Folder ini berisi contoh workflow CI/CD untuk men-deploy aplikasi
`sample-apps/payment-gateway` ke server training.

> **Catatan**: workflow di sini **tidak aktif otomatis**. Repo ini adalah
> repo materi, bukan repo produksi. Fork peserta training tidak seharusnya
> memicu deployment ke server instruktur.

## Pembagian Tanggung Jawab

| Tahap | Tools | Kapan Dijalankan |
|-------|-------|------------------|
| Provisioning server (install OS package, nginx, postgres, systemd unit, firewall, SELinux) | Ansible (`ansible-deploy/`) | Sekali saat server pertama dibangun, atau saat ada perubahan infrastruktur |
| Deploy aplikasi (rsync source, `npm install`, restart service) | GitHub Actions (`.github/workflows/deploy.yml`) | Setiap kali code aplikasi berubah |

Pemisahan ini adalah pola umum di dunia SRE:

- **Ansible** untuk hal yang jarang berubah dan butuh akses root penuh.
- **CI/CD** untuk hal yang sering berubah dan cukup butuh akses terbatas
  (rsync ke satu folder + restart satu service lewat `sudo` NOPASSWD
  yang di-whitelist).

## Alur Workflow `deploy.yml`

```
git push  ───►  GitHub Runner  ───►  SSH ke server target
                     │                      │
                     ├── checkout repo      ├── rsync source code
                     ├── npm ci (validasi)  ├── npm install --omit=dev
                     └── validasi config    ├── systemctl restart payment-gateway
                                            └── smoke test /api/health
```

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
