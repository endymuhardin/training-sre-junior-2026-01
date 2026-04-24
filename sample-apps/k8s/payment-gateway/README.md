# Lab Kubernetes — payment-gateway (HPA Demo)

Lab ini menambahkan satu konsep baru di atas fondasi
[`../hello-db/`](../hello-db/): **Horizontal Pod Autoscaler (HPA)**.

Kita pakai `endymuhardin/payment-gateway-js` karena image ini sudah punya
endpoint simulasi CPU load yang bisa diaktifkan runtime — pas untuk
memperlihatkan HPA scale up saat pod sibuk, scale down saat idle.

## Prasyarat

1. Cluster jalan, `kubectl` terhubung. Lihat [`../README.md`](../README.md).
2. **Metrics Server ter-install**. HPA tidak jalan tanpa ini. Cek:

   ```bash
   kubectl top nodes
   ```

   Kalau error `error: Metrics API not available`, install dulu per
   instruksi di [`../README.md`](../README.md) (section "Metrics Server").

## Isi folder

- [`payment-gateway.yaml`](./payment-gateway.yaml) — Deployment (replicas=2),
  Service, dan HPA (2-8 replica, target 50% CPU).

## Konsep kunci HPA

HPA adalah controller yang tiap 15 detik (default) melakukan:

1. Baca metrik `cpu` dari Metrics Server untuk semua pod yang match `scaleTargetRef`.
2. Hitung rata-rata utilization = `(used CPU) / (requested CPU) × 100%`.
3. Kalau > target (kita: 50%), hitung replica baru:
   `desired = ceil(current * utilization / target)`.
4. Update `replicas` di Deployment.

**Kenapa `resources.requests.cpu` wajib di-set**: Utilization persen
dihitung relatif terhadap requests. Kalau requests tidak ada, HPA tidak
punya basis denomitor → stuck di `unknown`.

## Jalankan

```bash
cd sample-apps/k8s/payment-gateway
kubectl apply -f payment-gateway.yaml
```

Tunggu pod Ready dan HPA aktif:

```bash
kubectl get pods,hpa -l app=payment-gateway -w
# tunggu:
#  pod/payment-gateway-...   1/1 Running
#  horizontalpodautoscaler/payment-gateway   cpu: 0%/50%    2  8  2
```

Kolom `TARGETS` di `hpa` menunjukkan `<current>/<target>`. Di awal idle:
`cpu: 0%/50%`.

Smoke test via LB port 3000 (ServiceLB bawaan k3s):

```bash
# dapatkan EXTERNAL-IP Service dan set VPS_IP
export VPS_IP=$(kubectl get svc payment-gateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "VPS_IP=$VPS_IP"

curl -s http://$VPS_IP:3000/api/health | jq
# {"status":"UP", ...}
```

Kalau port 3000 tertutup di firewall jalur laptop↔VPS, pakai NodePort
30300 (range 30000-32767 sudah dibuka oleh role k3s):

```bash
curl -s http://$VPS_IP:30300/api/health | jq
```

## Lab Drill: Trigger Scale-up dengan Load

### Langkah 1 — Aktifkan simulasi CPU

Image punya endpoint `PUT /api/config/cpu` untuk menyalakan CPU burn per
request. Set probability=1.0 (burn di setiap request) dan hashRounds=5000
(~25ms burn per request di container default size):

```bash
curl -s -X PUT http://$VPS_IP:3000/api/config/cpu \
  -H 'content-type: application/json' \
  -d '{"enabled": true, "probability": 1.0, "hashRounds": 5000}' | jq
```

Verifikasi:

```bash
curl -s http://$VPS_IP:3000/api/metrics | jq
```

### Langkah 2 — Buka tiga terminal observasi

**Terminal A — watch HPA**:

```bash
kubectl get hpa payment-gateway -w
# cek kolom TARGETS berubah dari 0% ke naik
```

**Terminal B — watch pods**:

```bash
kubectl get pods -l app=payment-gateway -w
# lihat pod baru di-create saat HPA scale up
```

**Terminal C — watch top**:

```bash
watch -n 2 kubectl top pods -l app=payment-gateway
# CPU tiap pod real-time
```

### Langkah 3 — Generate load

Dari terminal baru, loop request paralel. Ukuran 50 concurrent × 5 detik
biasanya cukup untuk memicu scale-up di container 100m CPU:

Pakai `hey` (https://github.com/rakyll/hey) kalau ada:

```bash
hey -z 3m -c 50 -m POST \
  -H 'content-type: application/json' \
  -d '{"amount":10000,"method":"QRIS"}' \
  http://$VPS_IP:3000/api/payments
```

Alternatif tanpa install tambahan — parallel curl loop:

```bash
for i in $(seq 1 50); do
  ( while true; do
      curl -s -X POST http://$VPS_IP:3000/api/payments \
        -H 'content-type: application/json' \
        -d '{"amount":10000,"method":"QRIS"}' >/dev/null
    done ) &
done
# biarkan 3 menit, Ctrl-C + killall curl untuk stop
```

### Langkah 4 — Amati perilaku HPA

Dalam 30-60 detik setelah load dimulai, di Terminal A:

```
NAME              REFERENCE                    TARGETS     MINPODS  MAXPODS  REPLICAS
payment-gateway   Deployment/payment-gateway   cpu: 0%/50%     2        8        2
payment-gateway   Deployment/payment-gateway   cpu: 80%/50%    2        8        2
payment-gateway   Deployment/payment-gateway   cpu: 95%/50%    2        8        4   ← scale up
payment-gateway   Deployment/payment-gateway   cpu: 60%/50%    2        8        6   ← scale up lagi
payment-gateway   Deployment/payment-gateway   cpu: 45%/50%    2        8        6
```

Perhatikan:

- HPA **tidak langsung scale up** begitu metric lewat threshold. Ada
  window 15 detik + algoritma yang membandingkan utilization current vs
  target.
- Setelah replicas naik, utilization **turun** karena load tersebar ke
  lebih banyak pod.
- Kalau `cpu%/50%` = `100%/50%`, HPA akan arahkan ke `replicas ≈ current
  × 100/50 = 2 × current`. Algoritma pakai ceiling.

### Langkah 5 — Stop load, amati scale-down

Matikan load generator (Ctrl-C + `killall curl`). Setelah ~1 menit
(stabilization window kita set 60s):

```
NAME              REFERENCE                    TARGETS     REPLICAS
payment-gateway   Deployment/payment-gateway   cpu: 5%/50%      6
payment-gateway   Deployment/payment-gateway   cpu: 2%/50%      5   ← scale down (1 pod per 30s)
payment-gateway   Deployment/payment-gateway   cpu: 2%/50%      4
...                                                              2   ← balik ke minReplicas
```

Scale-down **jauh lebih lambat** daripada scale-up, dan itu disengaja.
Alasannya: traffic sering bursty — kalau scale-down agresif, pod baru saja
dihapus lalu beban naik lagi → harus scale-up dari kondisi capacity
kurang. Lebih aman overprovision sebentar.

## Deliverable Peserta

Laporan singkat:

1. Screenshot `kubectl get hpa -w` dari baseline → peak → back-to-min,
   dengan timestamp.
2. Hitung: berapa detik dari load-start sampai replica pertama nambah?
3. Hitung: berapa replica maksimum tercapai, dan berapa utilization final
   saat plateau?
4. Jelaskan kenapa scale-down memakan waktu lebih lama. Apa resiko kalau
   scale-down diset terlalu agresif?
5. Bonus: apa yang terjadi kalau `maxReplicas` dicapai tapi utilization
   tetap > target? (Jawab dengan eksperimen: set `maxReplicas: 3`, ulangi
   load.)

## Teardown

```bash
kubectl delete -f payment-gateway.yaml
```

## Latihan

1. **Memory-based HPA**. Ganti `metric.resource.name` dari `cpu` ke
   `memory`. Set `simulation.memory.retainRecords=true` via PUT
   `/api/config/memory` untuk bikin pod nyimpan payload di-memory.
   Trigger scale-up berdasar memory growth.
2. **Multi-metric HPA**. Tambahkan dua metric (cpu DAN memory) di list
   `metrics:`. HPA scale sesuai yang paling tinggi rasionya. Buktikan
   dengan load yang dominan salah satu sumber.
3. **Custom metric via Prometheus adapter**. (advanced, optional) Pakai
   metric `http_requests_per_second` alih-alih CPU. Butuh Prometheus +
   prometheus-adapter ter-install.
4. **VPA vs HPA**. Jelaskan beda Vertical Pod Autoscaler dengan
   Horizontal. Skenario mana yang lebih cocok: app stateless web tier,
   app dengan memory footprint besar dan traffic konstan, batch job?
