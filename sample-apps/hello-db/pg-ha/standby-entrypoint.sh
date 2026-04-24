#!/bin/bash
# Entrypoint pg-standby.
#
# Logika:
#   - Kalau $PGDATA belum pernah di-init (PG_VERSION belum ada),
#     bootstrap via pg_basebackup dari pg-primary.
#   - Setelah itu (atau kalau sudah pernah init), delegasikan ke
#     docker-entrypoint.sh bawaan image untuk start postgres.
#
# pg_basebackup -R → otomatis menulis standby.signal + primary_conninfo
# di postgresql.auto.conf, sehingga postgres start sebagai hot standby.
set -euo pipefail

: "${PGDATA:=/var/lib/postgresql/data}"
: "${PRIMARY_HOST:?env PRIMARY_HOST wajib di-set}"
: "${PRIMARY_PORT:?env PRIMARY_PORT wajib di-set}"
: "${REPL_USER:?env REPL_USER wajib di-set}"
: "${REPL_PASSWORD:?env REPL_PASSWORD wajib di-set}"

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[standby] PGDATA kosong — bootstrap via pg_basebackup dari ${PRIMARY_HOST}:${PRIMARY_PORT}"

  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 0700 "$PGDATA"

  export PGPASSWORD="$REPL_PASSWORD"

  # Tunggu primary siap menerima koneksi replication.
  # pg_isready tidak cek authentication — cukup untuk "server accept TCP".
  until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$REPL_USER" >/dev/null 2>&1; do
    echo "[standby] menunggu primary…"
    sleep 2
  done

  su postgres -c "pg_basebackup \
      --host=$PRIMARY_HOST \
      --port=$PRIMARY_PORT \
      --username=$REPL_USER \
      --pgdata=$PGDATA \
      --format=plain \
      --wal-method=stream \
      --write-recovery-conf \
      --progress \
      --verbose"

  echo "[standby] bootstrap selesai — standby.signal tertulis oleh -R"
fi

# Serahkan ke entrypoint bawaan image supaya logic standard (drop privileges,
# environment processing, dll) tetap jalan.
exec docker-entrypoint.sh postgres
