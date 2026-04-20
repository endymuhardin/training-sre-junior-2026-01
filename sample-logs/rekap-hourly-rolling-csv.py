import re
import csv
from datetime import datetime
from collections import Counter, defaultdict

def parse_logs_to_csv(log_file, output_csv="rekap_transaksi.csv", window_hours=1):
    """
    Memproses log dan mengekspor hasilnya ke file CSV.
    """
    # Regex untuk menangkap data dari format Spring Boot
    log_pattern = re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*MTD: (?P<method>\w+) \| RC: (?P<rc>\w+) \| STATUS: (?P<status>\w+)"
    )

    # Dictionary untuk menampung statistik per jam
    rolling_data = defaultdict(lambda: {
        "total": 0, 
        "success": 0, 
        "failed": 0, 
        "error_codes": Counter()
    })

    try:
        with open(log_file, 'r') as file:
            for line in file:
                match = log_pattern.search(line)
                if match:
                    # 1. Normalisasi Waktu ke Jam
                    dt = datetime.strptime(match.group('ts'), "%Y-%m-%d %H:%M:%S")
                    hour_bucket = (dt.hour // window_hours) * window_hours
                    time_key = dt.replace(hour=hour_bucket, minute=0, second=0, microsecond=0)

                    # 2. Ambil Data
                    status = match.group('status')
                    rc = match.group('rc')
                    
                    # 3. Update Statistik
                    bucket = rolling_data[time_key]
                    bucket["total"] += 1
                    if status == "SUCCESS":
                        bucket["success"] += 1
                    else:
                        bucket["failed"] += 1
                        bucket["error_codes"][rc] += 1

        # 4. Tulis ke File CSV
        write_to_csv(rolling_data, output_csv)
        print(f"Berhasil mengekspor rekap ke: {output_csv}")

    except FileNotFoundError:
        print(f"File {log_file} tidak ditemukan.")

def write_to_csv(rolling_data, output_csv):
    # Header CSV
    header = [
        "timestamp", 
        "total_transactions", 
        "success_count", 
        "failed_count", 
        "success_rate_percent", 
        "most_frequent_error_rc"
    ]

    with open(output_csv, mode='w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(header)

        # Urutkan berdasarkan waktu agar rapi di Excel/Sheets
        for ts in sorted(rolling_data.keys()):
            data = rolling_data[ts]
            
            # Hitung Success Rate
            sr = round((data['success'] / data['total'] * 100), 2) if data['total'] > 0 else 0
            
            # Ambil RC error yang paling sering muncul
            top_error = data['error_codes'].most_common(1)
            dominant_rc = top_error[0][0] if top_error else "N/A"

            # Tulis baris data
            writer.writerow([
                ts.strftime("%Y-%m-%d %H:%M"),
                data['total'],
                data['success'],
                data['failed'],
                sr,
                dominant_rc
            ])

if __name__ == "__main__":
    # Jalankan proses konversi
    parse_logs_to_csv("spring_boot_payment.log", "rekap_transaksi_hourly.csv", window_hours=24)