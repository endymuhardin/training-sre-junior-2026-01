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

## Lab: Skenario k8s

Tiga drill praktis. Pre-req semua: stack ter-apply, semua pod Ready,
dan variabel `VPS_IP` sudah di-set:

```bash
export VPS_IP=$(kubectl get svc hello-db -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "VPS_IP=$VPS_IP"
```

Target waktu: Lab A ~20 menit, Lab B ~15 menit, Lab C ~15 menit.

---

### Lab A — Scaling & Self-healing

**Tujuan**: peserta dapat (1) membuktikan Service k8s melakukan LB
otomatis, (2) scale replica naik-turun tanpa edit file manifest,
(3) mendemonstrasikan self-healing kontroler Deployment, (4) membuktikan
data Postgres tetap selamat saat pod-nya di-delete (PVC persistence).

#### Setup dua terminal

**Terminal 1 (observer)** — loop request kontinu:

```bash
while true; do
  printf "%s " "$(date +%H:%M:%S)"
  curl -m 2 -sS http://$VPS_IP:8080/whoami \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['instance'])" \
    || echo "ERROR"
  sleep 0.3
done
```

**Terminal 2 (operator)** — eksekusi perubahan state cluster.

#### Langkah drill

1. **Baseline** — dari Terminal 1 amati ~10 detik. Pastikan 3 nama pod
   yang berbeda muncul di output, kira-kira merata.

2. **Scale up ke 8 replica** (Terminal 2):
   ```bash
   kubectl scale deployment hello-db-app --replicas=8
   ```
   Tunggu semua Ready:
   ```bash
   kubectl wait pod -l app=hello-db --for=condition=Ready --timeout=60s
   ```
   Amati Terminal 1: dalam 20-30 detik, request mulai mendarat di
   5 pod baru. Hitung sebaran 20 request terakhir:
   ```bash
   # ambil snapshot di Terminal 2 — harus muncul 8 nama pod
   for i in $(seq 1 24); do
     curl -s http://$VPS_IP:8080/whoami \
       | python3 -c "import sys,json; print(json.load(sys.stdin)['instance'])"
   done | sort | uniq -c
   ```

3. **Scale down ke 3 replica**:
   ```bash
   kubectl scale deployment hello-db-app --replicas=3
   ```
   Amati Terminal 1: beberapa pod hilang dari rotasi; tidak ada baris
   `ERROR` karena k8s men-drain koneksi dulu sebelum terminate.

4. **Inject failure — SIGKILL satu pod**:
   ```bash
   POD=$(kubectl get pods -l app=hello-db -o jsonpath='{.items[0].metadata.name}')
   T0=$(date +%H:%M:%S)
   echo "T0 $T0 killing $POD"
   kubectl delete pod "$POD" --grace-period=0 --force
   ```
   Catat `T0`. Amati di Terminal 1:
   - `T1` = waktu terakhir `$POD` muncul.
   - `T2` = waktu pod pengganti (nama beda) muncul pertama kali.
   - Cek total pod: `kubectl get pods -l app=hello-db --no-headers | wc -l`
     — harus tetap 3.
   - Cek apakah ada baris `ERROR` di Terminal 1.

5. **PVC persistence drill**:
   ```bash
   # tulis data baru
   curl -s -X POST http://$VPS_IP:8080/greetings \
     -H 'content-type: application/json' \
     -d '{"body":"before-delete"}'
   echo

   # delete pod postgres (bukan sekadar restart — benar-benar terminate pod)
   T3=$(date +%H:%M:%S)
   kubectl delete pod -l app=postgres --grace-period=0 --force
   kubectl wait pod -l app=postgres --for=condition=Ready --timeout=60s
   T4=$(date +%H:%M:%S)

   # verifikasi data masih ada
   curl -s http://$VPS_IP:8080/greetings | grep -o 'before-delete'
   # expected output: before-delete
   ```
   Catat `T3`→`T4`: berapa detik pod postgres baru mencapai Ready.

#### Deliverable peserta

Laporan singkat berisi:

- Sebaran instance di langkah 2 (tabel count per-pod) — apakah
  betul-betul tersebar ~3 request per pod?
- Timeline dengan `T0`, `T1`, `T2` dari langkah 4. Selisih `T2-T0`
  adalah detection+recovery time. Bandingkan angkanya dengan angka
  Day 5 (HAProxy drop DOWN setelah `inter 2s × fall 2` = 4s).
- Jumlah baris `ERROR` di Terminal 1 selama langkah 4 — dan penjelasan
  kenapa ada / tidak ada.
- `T4-T3` dari langkah 5, plus output `grep -o 'before-delete'`. Apa
  yang akan terjadi kalau `postgres.yaml` pakai `emptyDir` alih-alih PVC?

#### Reset

Stack tetap bisa dipakai untuk Lab B tanpa perlu re-apply. Hentikan
loop di Terminal 1 (Ctrl-C).

---

### Lab B — Rolling Update Zero-Downtime

**Tujuan**: peserta dapat (1) melakukan rolling update via
`kubectl set image`, (2) mengukur bahwa tidak ada request yang loss
selama rollout, (3) melakukan rollback.

**Pre-req tambahan**: image `endymuhardin/hello-db-go` sudah punya
dua tag published di Docker Hub: `2026.04.01` (lama) dan `2026.04.02`
(yang sedang di-deploy). Rollout = swap antar dua tag ini.

#### Langkah drill

1. **Baseline** — catat versi sekarang:
   ```bash
   kubectl get deploy hello-db-app \
     -o jsonpath='{.spec.template.spec.containers[0].image}'
   echo
   kubectl rollout history deployment/hello-db-app
   ```

2. **Siapkan Terminal observer** — loop kontinu dengan counter
   OK/FAIL:
   ```bash
   ok=0; fail=0
   while true; do
     if curl -sf --max-time 2 http://$VPS_IP:8080/whoami >/dev/null; then
       ok=$((ok+1))
     else
       fail=$((fail+1))
     fi
     printf "\r%s  OK=%d  FAIL=%d" "$(date +%H:%M:%S)" "$ok" "$fail"
     sleep 0.2
   done
   ```
   Biarkan jalan.

3. **Trigger rollout** ke versi lama (Terminal 2):
   ```bash
   T0=$(date +%H:%M:%S)
   echo "T0 $T0"
   kubectl set image deployment/hello-db-app \
     app=endymuhardin/hello-db-go:2026.04.01
   kubectl rollout status deployment/hello-db-app
   T1=$(date +%H:%M:%S)
   echo "T1 $T1"
   ```

4. **Amati Terminal observer** selama rollout. Rollout kira-kira butuh
   20-40 detik karena strategy `maxSurge=1 maxUnavailable=0` —
   pod baru Ready dulu, baru pod lama dimatikan, satu per satu.

5. **Verifikasi image baru**:
   ```bash
   kubectl get pods -l app=hello-db \
     -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'
   # semua pod harus pakai tag :2026.04.01
   ```

6. **Rollback**:
   ```bash
   kubectl rollout undo deployment/hello-db-app
   kubectl rollout status deployment/hello-db-app
   ```
   Verifikasi image kembali ke `:2026.04.02`.

7. **Bonus — forced-fail rollout**: set image ke tag yang tidak ada
   (`endymuhardin/hello-db-go:2026.99.99`). Apa yang terjadi?
   Apakah ada traffic loss?
   ```bash
   kubectl set image deployment/hello-db-app \
     app=endymuhardin/hello-db-go:2026.99.99
   # tunggu 30 detik
   kubectl rollout status deployment/hello-db-app --timeout=30s || true
   kubectl get pods -l app=hello-db
   # kembalikan
   kubectl rollout undo deployment/hello-db-app
   ```

#### Deliverable peserta

- Nilai `OK` dan `FAIL` akhir di Terminal observer setelah rollout
  selesai. Hitung persen failure.
- Selisih `T1-T0` — berapa lama full rollout untuk 3 replica.
- Jawaban: apa fungsi `maxSurge` dan `maxUnavailable` di manifest?
  Apa yang berubah di user experience kalau `maxUnavailable: 1`?
- Dari langkah 7 (bonus), apakah traffic tetap lancar meski rollout
  gagal? Kenapa?

#### Reset

Pastikan image kembali ke `:2026.04.02`:

```bash
kubectl get deploy hello-db-app \
  -o jsonpath='{.spec.template.spec.containers[0].image}'; echo
```

Hentikan Terminal observer loop.

---

### Lab C — Readiness Probe & Service Endpoints

**Tujuan**: peserta dapat (1) membuktikan Service drop pod NotReady
dari endpoint list, (2) memahami kenapa liveness probe **tidak** dipakai
untuk dependency DB, (3) mengukur waktu detect + recovery saat DB mati.

#### Langkah drill

1. **Baseline — cek endpoints Service**:
   ```bash
   kubectl get endpoints hello-db
   # expected: 3 IP:port di subsets.addresses (satu per pod Ready)
   ```

2. **Break backend** — scale postgres ke 0:
   ```bash
   T0=$(date +%H:%M:%S); echo "T0 $T0"
   kubectl scale deployment postgres --replicas=0
   ```

3. **Amati transisi pod hello-db**:
   ```bash
   # polling sampai semua pod hello-db NotReady (READY 0/1)
   while kubectl get pods -l app=hello-db --no-headers | grep -q "1/1"; do
     sleep 1
     date +%H:%M:%S
     kubectl get pods -l app=hello-db --no-headers
   done
   T1=$(date +%H:%M:%S); echo "T1 $T1 all pods NotReady"
   ```
   Catat `T1-T0`. Ini adalah `readinessProbe failureThreshold × periodSeconds`
   (= 2 × 5 = 10 detik) plus latensi aktual ping DB.

4. **Cek dampak ke Service**:
   ```bash
   kubectl get endpoints hello-db
   # subsets harus kosong ATAU notReadyAddresses populated

   curl -sS --max-time 5 http://$VPS_IP:8080/ready; echo
   # expected: timeout atau connection refused
   #   (atau 503 kalau pod masih dalam status "sudah start probe tapi belum gagal 2x")
   ```

5. **Verifikasi pod-nya masih Running** meski NotReady:
   ```bash
   kubectl get pods -l app=hello-db
   # STATUS kolom: Running, READY kolom: 0/1
   ```
   Pod TIDAK di-restart oleh k8s karena kita pakai **readiness** probe,
   bukan liveness. Liveness probe (`/health`) masih lulus karena
   tidak sentuh DB.

6. **Recovery**:
   ```bash
   T2=$(date +%H:%M:%S); echo "T2 $T2"
   kubectl scale deployment postgres --replicas=1
   kubectl wait pod -l app=postgres --for=condition=Ready --timeout=60s

   # polling sampai semua hello-db pod kembali Ready
   while kubectl get pods -l app=hello-db --no-headers | grep -q "0/1"; do
     sleep 1
   done
   T3=$(date +%H:%M:%S); echo "T3 $T3 all hello-db Ready"
   ```
   Catat `T3-T2`.

7. **Verifikasi traffic mengalir lagi**:
   ```bash
   curl -s http://$VPS_IP:8080/ready; echo
   # expected: {"status":"UP","instance":"...","db":"connected"}
   ```

#### Deliverable peserta

- `T1-T0` dari langkah 3 — berapa detik sampai semua hello-db pod jadi
  NotReady? Bandingkan dengan nilai `failureThreshold × periodSeconds`
  di manifest.
- `T3-T2` dari langkah 6 — recovery time.
- Snapshot output `kubectl get endpoints hello-db` **saat DB mati**
  dan **setelah recovery**.
- Jawaban: kenapa kita pakai `readinessProbe` yang ping DB, bukan
  `livenessProbe`? Apa yang akan terjadi kalau kita bolak-balik?
  (hint: pod bakal di-restart loop → apakah itu yang kita mau saat
  DB down sebentar?)
- Jawaban: bedakan tiga status pod: Running+Ready, Running+NotReady,
  CrashLoopBackOff. Di masing-masing status, apakah Service kirim
  traffic?

#### Reset

```bash
# pastikan postgres up lagi
kubectl get deploy postgres
```

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
4. **Config hot-reload?** Edit ConfigMap `hello-db-config` (misal ubah
   `DB_PORT`). Apakah pod existing langsung lihat perubahan? Uji dan
   jelaskan. Apa yang perlu dilakukan supaya berubah (hint: `kubectl
   rollout restart deployment/hello-db-app`).
5. **Tweak probe thresholds**. Ubah `readinessProbe.failureThreshold`
   dari 2 ke 5, `periodSeconds` dari 5 ke 10. Ulangi Lab C — bagaimana
   dampaknya terhadap waktu detect? Kapan Anda mau probe lebih sabar
   vs lebih agresif?
