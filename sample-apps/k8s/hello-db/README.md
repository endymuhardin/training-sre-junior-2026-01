# Lab Kubernetes — hello-db (Convert Compose ke k8s)

Lab ini mengubah stack `docker-compose.ha.yml` (3 app + HAProxy + Postgres)
menjadi manifest Kubernetes. Tujuan: peserta melihat bahwa topologi yang
sudah dikenal dari sesi Day 5 bisa direkspresikan lebih ringkas di k8s,
dan mendapat "quality-of-life moments" seperti `kubectl scale` yang tidak
mungkin di compose.

Source code aplikasi **tidak** ada di folder ini — image sudah di-build
dan publish di Docker Hub (`endymuhardin/hello-db-go:2026.04.02`). Ini
menegaskan: k8s mengonsumsi image yang sudah jadi; deployment dan source
code adalah dua concern berbeda.

## Prasyarat

Cluster k8s jalan dan `kubectl` bisa connect. Lihat
[`../README.md`](../README.md) untuk setup kind/k3s.

Verifikasi:

```bash
kubectl get nodes
# NAME                  STATUS   ROLES           AGE   VERSION
# kind-control-plane    Ready    control-plane   5m    v1.30.0
```

## Mapping compose → k8s

Semua konsep Day-5 punya padanan langsung di k8s. Tidak ada ide baru di
level topologi — hanya dialek YAML yang berbeda.

| `docker-compose.ha.yml`                              | Manifest k8s di folder ini                | Apa yang hilang / berubah             |
|------------------------------------------------------|-------------------------------------------|---------------------------------------|
| `app1`, `app2`, `app3` (3 block service identik)     | 1 Deployment `hello-db-app`, `replicas: 3` | Block duplikasi hilang. Mau 10 pod? ganti angka |
| `lb` service + `haproxy:3.0-alpine` + `haproxy.cfg`  | 1 Service `hello-db` (LoadBalancer via k3s ServiceLB) | Container LB + config file hilang total |
| `depends_on: condition: service_healthy`             | `readinessProbe` pada pod app              | Sama semantik, ekspresi lebih bersih  |
| `INSTANCE_ID: app1/app2/app3` (enumerasi manual)     | Downward API: `fieldRef: metadata.name`    | k8s sudah kasih nama unik per pod     |
| `db` service + volume `db-data`                      | Deployment `postgres` + PVC + Service + Secret | PVC via `local-path` StorageClass → data survive pod delete |
| `docker compose up -d`                               | `kubectl apply -f .`                       | Rhythm mirip                          |
| Static 3 replica, restart manual                     | `kubectl scale deployment ... --replicas=N` | Scale tanpa edit file              |
| `docker compose up -d --build app1` (tidak zero-downtime di compose) | `kubectl set image ...` dengan RollingUpdate strategy | Benar-benar zero-downtime |
| Container crash = diam                               | Pod crash = k8s auto-recreate              | Self-healing gratis                   |

## Isi folder

- [`postgres.yaml`](./postgres.yaml) — ConfigMap (shared), Secret (password),
  PersistentVolumeClaim (data 1Gi via `local-path`), Deployment Postgres,
  Service Postgres.
- [`hello-db.yaml`](./hello-db.yaml) — Deployment hello-db-app (replicas=3,
  probes, Downward API) + Service hello-db.

Dibaca dalam urutan itu: Postgres duluan supaya app punya backend saat
pertama Ready.

## Jalankan stack

```bash
cd sample-apps/k8s/hello-db
kubectl apply -f postgres.yaml
kubectl apply -f hello-db.yaml
```

Tunggu semua pod Ready:

```bash
kubectl get pods -w
# Ctrl-C setelah semua pod Running 1/1

kubectl get deploy,svc,cm,secret
```

**Smoke test** — Service type LoadBalancer di k3s di-handle oleh
ServiceLB bawaan. `EXTERNAL-IP` otomatis di-set ke IP node. Dari laptop
peserta, akses via IP VPS langsung:

```bash
# ganti <VPS-IP> dengan IP VPS Anda (cek via `ip -4 addr` di VPS)
curl -s http://<VPS-IP>:8080/whoami
# {"instance":"hello-db-app-5c7d8b9f6-abcde","servedAt":"..."}

curl -sSI http://<VPS-IP>:8080/whoami | grep -i x-instance-id
# X-Instance-Id: hello-db-app-5c7d8b9f6-abcde
```

Kalau port 8080 belum terbuka di firewall laptop/router/cloud,
fallback pakai NodePort di range yang sudah dibuka role k3s:

```bash
curl -s http://<VPS-IP>:30080/whoami
```

Cek bahwa Service benar punya `EXTERNAL-IP`:

```bash
kubectl get svc hello-db
# NAME      TYPE           CLUSTER-IP       EXTERNAL-IP    PORT(S)          AGE
# hello-db  LoadBalancer   10.43.183.136    10.0.120.6     8080:30080/TCP   2m
```

`INSTANCE_ID` berisi nama pod lengkap, bukan `app1/2/3`. Ini adalah efek
dari `fieldRef: metadata.name` di manifest — tiap pod dapat identity
unik otomatis.

**Catatan**: `kubectl port-forward svc/hello-db 8080:8080` **tidak**
memperlihatkan load balancing — port-forward pick satu pod random dan
stick di situ. LoadBalancer / NodePort masuk via kube-proxy yang
iptables rule-nya beneran round-robin ke semua pod Ready. Pakai LB/NP
untuk demo LB; pakai port-forward untuk debug satu pod spesifik.

## Lima Demo Live

Urutan ini adalah inti dari lab — tiap demo punya padanan di compose yang
lebih rumit atau tidak mungkin.

**Prep**: set variabel environment supaya curl lebih singkat:

```bash
export VPS_IP=$(kubectl get svc hello-db -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "VPS_IP=$VPS_IP"
```

### Demo 1 — Round-robin default ke semua pod

```bash
for i in $(seq 1 6); do
  curl -s http://$VPS_IP:8080/whoami \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['instance'])"
done
```

Tiap request kena pod berbeda. Service k8s (via kube-proxy + ServiceLB)
melakukan LB tanpa config tambahan. Bandingkan dengan
[`haproxy.cfg`](../../hello-db/haproxy.cfg) di Day 5 — sekitar 50 baris
konfigurasi dihapus.

### Demo 2 — Scale naik/turun live

```bash
kubectl scale deployment hello-db-app --replicas=8
kubectl get pods -l app=hello-db -w
# Ctrl-C setelah semua 8 pod Running 1/1

# traffic sekarang mendarat di 8 pod yang berbeda
for i in $(seq 1 16); do
  curl -s http://$VPS_IP:8080/whoami \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['instance'])"
done | sort | uniq -c
# harus muncul 8 nama pod, masing-masing ~2 kali
```

Turunkan kembali:

```bash
kubectl scale deployment hello-db-app --replicas=3
```

**Diskusi**: di compose, "mau 8 replica" = tambah 5 block service + restart
`docker compose up`. Di k8s, 1 perintah, tanpa downtime.

### Demo 3 — Self-healing saat pod mati

Pilih salah satu pod dan delete:

```bash
POD=$(kubectl get pods -l app=hello-db -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "$POD"

# pod baru langsung dibuat oleh Deployment controller
kubectl get pods -l app=hello-db
```

Sepanjang proses, Service tetap merutekan traffic ke pod Ready yang ada.
Pod baru masuk rotasi otomatis begitu Ready.

```bash
# Bukti: request tidak pernah gagal selama rebuild pod
for i in $(seq 1 20); do
  curl -sf --max-time 2 http://$VPS_IP:8080/whoami >/dev/null \
    && echo "$(date +%H:%M:%S) OK" \
    || echo "$(date +%H:%M:%S) FAIL"
  sleep 0.3
done
```

**Diskusi**: `docker compose` tidak restart container yang di-delete
manual. k8s punya *control loop* yang terus-menerus membandingkan
desired state (replicas=3) dengan actual state (ada 2), lalu melakukan
koreksi.

**Extension — data persistence via PVC**: coba delete pod postgres.

```bash
# bikin data
curl -s -X POST http://$VPS_IP:8080/greetings \
  -H 'content-type: application/json' \
  -d '{"body":"before-delete"}'
echo

# delete pod postgres
kubectl delete pod -l app=postgres

# tunggu pod postgres baru Ready
kubectl wait pod -l app=postgres --for=condition=Ready --timeout=60s

# verifikasi: greeting tadi masih ada
curl -s http://$VPS_IP:8080/greetings | jq
# harus muncul {"body":"before-delete", ...}
```

Data survive karena di `postgres.yaml` kita pakai `PersistentVolumeClaim`,
bukan emptyDir. PVC di-provision oleh `local-path` StorageClass k3s di
host disk (`/var/lib/rancher/k3s/storage/`). Pod baru di-schedule, PVC
di-mount, data di-mount in-place.

### Demo 4 — Rolling update zero-downtime

Ganti tag image dari `2026.04.02` ke `2026.04.01` (versi sebelumnya):

```bash
kubectl set image deployment/hello-db-app app=endymuhardin/hello-db-go:2026.04.01

# watch rollout
kubectl rollout status deployment/hello-db-app

# selama rollout, traffic tetap lancar (run di terminal lain):
for i in $(seq 1 40); do
  curl -sf --max-time 2 http://$VPS_IP:8080/whoami >/dev/null \
    && echo "$(date +%H:%M:%S) OK" \
    || echo "$(date +%H:%M:%S) FAIL"
  sleep 0.3
done
```

Rollback kalau perlu:

```bash
kubectl rollout undo deployment/hello-db-app
kubectl rollout history deployment/hello-db-app
```

**Diskusi**: RollingUpdate strategy + readinessProbe = k8s menunggu pod
baru benar-benar Ready sebelum mematikan pod lama. `maxUnavailable: 0`
di manifest menjamin tidak ada saat kapasitas turun di bawah target.

### Demo 5 — Readiness probe memutus routing saat DB tidak sehat

Matikan backend DB:

```bash
kubectl scale deployment postgres --replicas=0
```

Tunggu ~15-20 detik. Lihat status pod app:

```bash
kubectl get pods -l app=hello-db
# STATUS berubah: Running 1/1 → Running 0/1 (readiness fail, belum Ready)
```

Coba hit Service:

```bash
curl -sS --max-time 5 http://$VPS_IP:8080/ready
echo
# - balik 503 kalau masih ada pod yang probe DB (fail)
# - timeout / connection refused kalau semua pod NotReady (Service
#   tidak punya endpoint; LB tidak bisa rutekan ke pod manapun)
```

`kubectl get endpoints hello-db` — harus kosong (tidak ada pod Ready).

Bangkitkan kembali:

```bash
kubectl scale deployment postgres --replicas=1
# tunggu postgres Ready, lalu hello-db pods ikut Ready lagi
```

**Diskusi**: tanpa probe, Service akan tetap kirim traffic ke pod yang
app-nya "hidup tapi DB-nya putus" → 5xx ke user. Probe memungkinkan k8s
"tahu" kapan pod tidak siap meski proses masih jalan.

## Teardown

```bash
kubectl delete -f hello-db.yaml
kubectl delete -f postgres.yaml
```

Atau sekaligus:

```bash
kubectl delete -f .
```

## Latihan

1. **Tambah anti-affinity**. Pastikan 3 pod hello-db selalu tersebar di
   node berbeda (`podAntiAffinity`). Uji di cluster multi-node.
2. **Telusuri ServiceLB**. Dengan stack up, cari pod yang menghandle
   port 8080 di host: `kubectl -n kube-system get pods -l svccontroller.k3s.cattle.io/svcname=hello-db`.
   Lihat `kubectl describe pod svclb-hello-db-...` — container apa yang
   jalan? Di mana port 8080 di-bind? Apa bedanya kalau service ganti ke
   `type: ClusterIP` (pod svclb hilang)?
3. **Rekam rolling update**. Gunakan `kubectl rollout pause` / `resume`
   untuk canary: naikkan 1 pod ke versi baru, verifikasi, baru lanjutkan
   sisanya.
4. **Break Postgres, ukur MTTR**. Stop Postgres Deployment, hitung berapa
   detik sampai semua hello-db pod NotReady. Bangkitkan Postgres, hitung
   recovery time. Bandingkan angkanya dengan angka Day 5 (HAProxy 2s×2
   probe).
5. **Config hot-reload?** Edit ConfigMap `hello-db-config` (misal ubah
   `DB_PORT`). Apakah pod existing langsung lihat perubahan? Uji dan
   jelaskan. Apa yang perlu dilakukan supaya berubah?
