# Sample Apps — Kubernetes Labs

Folder ini berisi manifest k8s untuk mendeploy aplikasi-sample training.
**Tidak ada source code di sini** — manifest hanya me-reference image
yang sudah di-build dan di-publish (lihat `../hello-db/` dan
`../payment-gateway/` untuk source). Pemisahan folder ini sengaja
menegaskan: Kubernetes mengonsumsi image yang sudah jadi; manifest dan
source adalah dua concern berbeda (pola "app repo vs deployment repo"
di GitOps).

## Isi

| Folder | Konsep utama | Durasi lab |
|--------|-------------|------------|
| [`hello-db/`](./hello-db/)         | Terjemahan `docker-compose.ha.yml` ke k8s; Deployment, Service, ConfigMap, Secret, probes, Downward API; demo scale, self-heal, rolling update | ~40 menit |
| [`payment-gateway/`](./payment-gateway/) | Horizontal Pod Autoscaler (HPA) berbasis CPU metric | ~25 menit |

Urutan: kerjakan `hello-db/` dulu supaya konsep dasar k8s objects sudah
ter-internalisasi, baru lanjut ke `payment-gateway/` untuk HPA.

## Setup Cluster

### Opsi A — `k3s` di VPS peserta (rekomendasi)

Tiap peserta punya VPS sendiri. Install k3s sekali, langsung punya
cluster single-node yang real (bukan simulasi). Footprint ~500MB RAM,
muat di VPS 2 vCPU / 8 GB RAM.

**Install k3s**:

```bash
# ssh ke VPS peserta
curl -sfL https://get.k3s.io | sudo sh -s - \
  --write-kubeconfig-mode=644 \
  --disable=traefik

# flag yang dipakai:
#   --write-kubeconfig-mode=644  → kubeconfig bisa dibaca user non-root
#   --disable=traefik            → skip ingress bawaan (bukan topik hari ini)
```

**Verifikasi**:

```bash
sudo systemctl status k3s --no-pager | head -5
kubectl get nodes
# NAME            STATUS   ROLES                  AGE   VERSION
# vm-sre-pesertaN Ready    control-plane,master   30s   v1.30.x+k3s1
```

k3s bundling kubectl; kalau kubectl standalone belum di-install:

```bash
sudo ln -s /usr/local/bin/k3s /usr/local/bin/kubectl
# atau pakai: k3s kubectl <args>
```

Kubeconfig default di `/etc/rancher/k3s/k3s.yaml`. Export supaya kubectl
pakai path ini tanpa sudo:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
```

Semua kerja lab dilakukan **dari SSH session di VPS** — kubectl, curl
smoke test, dan load generator dijalankan di VPS yang sama. Tidak perlu
konfigurasi tunneling ke laptop.

**Uninstall** (kalau mau reset total):

```bash
sudo /usr/local/bin/k3s-uninstall.sh
```

### Opsi B — `kind` di laptop (alternatif)

Kalau peserta ingin latihan di laptop sendiri tanpa VPS. Butuh Docker
sudah terpasang.

```bash
# install (macOS)
brew install kind kubectl

# install (Linux)
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64
chmod +x kind && sudo mv kind /usr/local/bin/
```

Bikin cluster:

```bash
kind create cluster --name sre-training
```

Uninstall cluster:

```bash
kind delete cluster --name sre-training
```

Catatan: untuk lab HPA dengan kind, metrics-server perlu patch
`--kubelet-insecure-tls` (lihat section Metrics Server di bawah).

## Metrics Server (wajib untuk lab HPA)

`kind` dan `k3s` vanilla tidak menyertakan metrics-server. Install sekali
sebelum lab payment-gateway:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

**Hanya untuk `kind`** — metrics-server default mensyaratkan kubelet TLS
valid. Di kind ini gagal. Tambah flag `--kubelet-insecure-tls`:

```bash
kubectl patch -n kube-system deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
```

Tunggu metrics-server Ready (~30 detik), lalu verifikasi:

```bash
kubectl top nodes
kubectl top pods -A
```

Kalau `top` balik angka, metrics-server ready dan HPA bisa jalan.

## Troubleshooting umum

**Pod stuck Pending** — biasanya resource tidak cukup di cluster. Cek
`kubectl describe pod <name>`, lihat bagian `Events`. Di kind dengan 2
worker kecil, lab ini sudah di-sizing supaya muat.

**ImagePullBackOff** — image gagal pull. Untuk lab hello-db & payment-gateway
pakai image public di Docker Hub, seharusnya tidak kena. Cek
konektivitas: `docker pull endymuhardin/hello-db-go:2026.04.02` di host.

**`kubectl top` balik `error: Metrics API not available`** — metrics-server
belum install atau belum Ready. Lihat section di atas.

**HPA `TARGETS` stuck `unknown`** — biasanya container tidak punya
`resources.requests.cpu`. HPA tidak bisa hitung persen utilization tanpa
denominator.

## Sesudah semua lab

Hapus semua resource milik training:

```bash
kubectl delete -f hello-db/
kubectl delete -f payment-gateway/
```

Atau lebih total — hapus cluster kind:

```bash
kind delete cluster --name sre-training
```
