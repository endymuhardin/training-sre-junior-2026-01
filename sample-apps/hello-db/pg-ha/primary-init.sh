#!/bin/bash
# Dijalankan otomatis oleh official postgres entrypoint dari
# /docker-entrypoint-initdb.d saat data dir fresh. Tugas:
#   1. Buat role khusus replikasi (hak REPLICATION, bukan superuser)
#   2. Izinkan koneksi replication dari network docker-compose
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replpass';
SQL

# pg_hba entry: standby di dalam compose network akan connect sebagai
# "replicator". Pakai scram-sha-256 supaya password tidak plain-text.
cat >> "$PGDATA/pg_hba.conf" <<-HBA
host replication replicator 0.0.0.0/0 scram-sha-256
HBA
