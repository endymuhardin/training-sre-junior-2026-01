# Payment Gateway Simulator — image Docker untuk Express.js app.
#
# Pilihan single-stage: aplikasi Node.js di sini TIDAK punya compile step
# (JS di-ship as-is). Multi-stage hanya memberi nilai tambah kalau ada
# langkah build yang output-nya perlu dipisahkan dari runtime (mis.
# TypeScript → JS, atau Go source → binary — lihat sample-apps/hello-db/
# untuk contoh multi-stage yang tepat). Untuk Node-only app tanpa
# compile, single-stage lebih jujur dan lebih simple.
#
# Node 24 LTS (Krypton) — LTS terbaru yang masih supported per April 2026.
# Node 20 sudah EOL (2026-03-24). Lihat schedule resmi di:
# https://nodejs.org/en/about/previous-releases

FROM node:24-alpine

# Label metadata statis. Label dinamis (version, revision, source) di-inject
# oleh `docker/metadata-action` di workflow CI — tidak perlu hardcode di sini.
LABEL org.opencontainers.image.title="Payment Gateway Simulator" \
      org.opencontainers.image.description="Express.js + pino payment gateway simulator untuk training SRE" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production

WORKDIR /app

# Install dependency duluan — layer ini ter-cache selama package*.json
# tidak berubah, sehingga edit di src/ tidak memicu re-download.
# --omit=dev skip devDependencies (kalau ada nanti: mocha, nodemon, dll.)
# --chown=node:node supaya file dimiliki user non-root dari awal.
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Salin hanya folder yang dibutuhkan runtime — bukan `COPY . .`.
# Hindarkan .git/, logs/, node_modules/ lokal, db-aplikasi/, loadtest/,
# logs/samples/ (436 KB sampel latihan) ikut ke image.
# .dockerignore sudah memfilter, tapi COPY eksplisit per-folder = dua lapis proteksi.
COPY --chown=node:node src ./src
COPY --chown=node:node config ./config

# Direktori log perlu dibuat manual supaya pino bisa menulis ke file
# saat app start. mkdir + chown sekaligus di satu RUN supaya jadi satu layer.
RUN mkdir -p /app/logs && chown node:node /app/logs

EXPOSE 3000

USER node

# Healthcheck lewat node bawaan — tidak butuh install curl/wget tambahan.
# /api/health tidak sentuh DB / dependency eksternal, cocok untuk liveness.
# process.env.PG_PORT mirror config app: kalau port di-override via env,
# healthcheck ikut port yang sama.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PG_PORT||3000)+'/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "src/app.js"]
