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

Model delivery: tiap peserta punya satu VPS (RHEL 9). Trainer bootstrap
semua VPS sekaligus pakai Ansible. Peserta SSH ke VPS masing-masing
untuk kerja lab.

### Opsi A — Ansible bootstrap (rekomendasi untuk training)

Role `ansible-deploy/roles/k3s` install k3s + metrics-server +
firewalld rules dalam satu run. Idempotent — aman di-execute berulang.

**Pre-req** di mesin trainer (laptop/bastion):

- `ansible-core` terinstall (cek: `ansible --version`)
- SSH key ke `azureuser` di semua VPS peserta

**Setup inventory**: edit
[`ansible-deploy/inventory/development.ini`](../../ansible-deploy/inventory/development.ini)
— ganti IP placeholder dengan IP VPS peserta.

```ini
[all]
10.0.120.6   ansible_user=azureuser
10.0.120.7   ansible_user=azureuser
10.0.120.8   ansible_user=azureuser
# ...satu baris per peserta
```

**Run playbook** — hits semua host di inventory paralel:

```bash
cd ansible-deploy
ansible-playbook playbooks/k8s.yml
```

Apa yang role lakukan di tiap VPS:

1. Buka port k3s di firewalld: kubelet (10250/tcp), Kubernetes API
   (6443/tcp), NodePort range (30000-32767/tcp), dan CIDR pod+service
   (10.42.0.0/16, 10.43.0.0/16) ke zone `trusted`.
2. Install k3s `v1.34.6+k3s1` (versi pinned di role defaults) dengan
   `--write-kubeconfig-mode=644 --disable=traefik`.
3. Symlink `/usr/local/bin/kubectl` → k3s binary.
4. Set `KUBECONFIG=/etc/rancher/k3s/k3s.yaml` secara global via
   `/etc/profile.d/k3s.sh` — otomatis kebawa di login shell.
5. Install metrics-server dari upstream manifest + patch
   `--kubelet-insecure-tls` (k3s kubelet pakai self-signed cert).
6. Smoke test: tunggu node Ready, tunggu metrics-server Ready,
   jalankan `kubectl top nodes` sampai output angka muncul.

Total eksekusi ~1-2 menit per VPS (terutama nunggu metrics-server
scrape pertama).

**Verifikasi per-VPS** — peserta SSH ke VPS masing-masing:

```bash
ssh azureuser@<VPS-IP>
kubectl get nodes
# NAME             STATUS   ROLES                  AGE     VERSION
# vm-sre-pesertaN  Ready    control-plane,master   2m      v1.34.6+k3s1

kubectl top nodes
# NAME             CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
# vm-sre-pesertaN  320m         16%      1277Mi          16%
```

Kalau `kubectl top nodes` balik angka → cluster siap untuk kedua lab.

**Re-run** aman — ansible role idempotent. Kalau ada VPS baru, cukup
tambah entry di inventory lalu re-run playbook (VPS yang sudah
ter-setup di-skip tasks).

**Uninstall** (per VPS):

```bash
sudo /usr/local/bin/k3s-uninstall.sh
```

### Opsi B — Manual `k3s` di VPS (kalau tidak pakai Ansible)

```bash
# ssh ke VPS
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.34.6+k3s1 \
  sudo sh -s - \
  --write-kubeconfig-mode=644 \
  --disable=traefik

# Buka firewall
sudo firewall-cmd --zone=trusted --add-source=10.42.0.0/16 --permanent
sudo firewall-cmd --zone=trusted --add-source=10.43.0.0/16 --permanent
sudo firewall-cmd --add-port=10250/tcp --permanent
sudo firewall-cmd --add-port=6443/tcp --permanent
sudo firewall-cmd --add-port=30000-32767/tcp --permanent
sudo firewall-cmd --reload

# Export kubeconfig
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' | sudo tee /etc/profile.d/k3s.sh

# Symlink kubectl
sudo ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl

# Install metrics-server
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system wait deployment metrics-server --for=condition=Available --timeout=120s
```

Isi perintah di atas identik dengan yang dijalankan role ansible —
dipakai kalau trainer tidak pakai Ansible, atau peserta mau pelajari
setup step-by-step.

### Opsi C — `kind` di laptop (alternatif tanpa VPS)

Untuk peserta yang latihan di laptop Mac/Linux sendiri. Butuh Docker.

```bash
# install (macOS)
brew install kind kubectl

# install (Linux)
curl -Lo ./kind https://kind.sigs.k8s.io/dl/latest/kind-linux-amd64
chmod +x kind && sudo mv kind /usr/local/bin/

# create cluster
kind create cluster --name sre-training

# install metrics-server + patch (mandatory untuk kind, sama alasan dengan k3s)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# uninstall
kind delete cluster --name sre-training
```

Catatan: `kind` tidak punya ServiceLB. Lab yang pakai
`type: LoadBalancer` di Opsi A/B akan `<pending>` selamanya — pakai
NodePort (`:30080`, `:30300`) via `curl http://localhost:<port>`.

## Metrics Server — info (opsional dibaca)

Kedua lab ini butuh metrics-server untuk:
- Lab payment-gateway (HPA berbasis `cpu` metric → butuh metric source).
- Lab hello-db — tidak wajib, tapi enak untuk `kubectl top pods`.

Opsi A (Ansible) sudah install otomatis. Untuk Opsi B/C ada di snippet
manual masing-masing.

Patch `--kubelet-insecure-tls` diperlukan karena baik k3s maupun kind
pakai kubelet serving cert yang self-signed. metrics-server default
verifikasi TLS-nya strict. Di produksi (managed k8s), cert rotation
sudah di-handle cloud provider jadi patch ini tidak perlu.

Verifikasi metrics-server jalan:

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
