# Base Image. Gunakan node image, daripada merakit ulang nodejs dari nol
# Pisahkan kegiatan build dengan image final yang akan dideliver
# Tahap 1 : Download dependensi dan build app (compile jika aplikasi Java atau Golang)
FROM node:24-alpine AS builder

# Aplikasi diinstal di folder /app dalam container
WORKDIR /app

# Copy package.json yang berisi daftar library
COPY package*.json ./

# Download library yang disebutkan dalam package.json 
RUN npm ci

# Copy isi current folder di laptop (titik pertama) 
# ke current folder dalam container (titik kedua)
COPY . .


# Tahap 2: Image yang akan menjalankan aplikasi
FROM node:24-alpine

# Optional, kalau kita ada perbedaan config antara dev vs prod
ENV NODE_ENV=production

WORKDIR /app

# Salin hanya file yang dibutuhkan dari tahap builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Kita buat folder 'logs' secara manual dan berikan hak akses ke user 'node'
RUN mkdir -p /app/logs && chown -R node:node /app

# Port aplikasi express biasanya 3000
EXPOSE 3000

USER node
CMD ["node", "src/app.js"]
