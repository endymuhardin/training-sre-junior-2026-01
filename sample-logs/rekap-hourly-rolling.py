import re
from datetime import datetime
from collections import Counter, defaultdict

def parse_hourly_rolling_logs(log_file, window_hours=1):
    """
    Memproses log dengan pengelompokan waktu berbasis JAM.
    :param window_hours: Ukuran jendela waktu dalam satuan jam (e.g., 1, 6, 12, atau 24).
    """
    # Regex untuk menangkap Timestamp dan Data Transaksi
    log_pattern = re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*MTD: (?P<method>\w+) \| RC: (?P<rc>\w+) \| STATUS: (?P<status>\w+)"
    )

    # Key: bucket waktu (datetime object), Value: dict statistik
    rolling_data = defaultdict(lambda: {"total": 0, "success": 0, "failed": 0, "errors": Counter()})

    try:
        with open(log_file, 'r') as file:
            for line in file:
                match = log_pattern.search(line)
                if match:
                    # 1. Parsing Timestamp
                    dt = datetime.strptime(match.group('ts'), "%Y-%m-%d %H:%M:%S")
                    
                    # 2. Normalisasi ke Window JAM
                    # Membulatkan jam ke bawah sesuai window_hours
                    hour_bucket = (dt.hour // window_hours) * window_hours
                    time_key = dt.replace(hour=hour_bucket, minute=0, second=0, microsecond=0)

                    # 3. Ambil data status dan RC
                    status = match.group('status')
                    rc = match.group('rc')
                    
                    # 4. Update Statistik di Bucket
                    bucket = rolling_data[time_key]
                    bucket["total"] += 1
                    
                    if status == "SUCCESS":
                        bucket["success"] += 1
                    else:
                        bucket["failed"] += 1
                        msg_match = re.search(r"MSG: (.*)", line)
                        error_msg = msg_match.group(1) if msg_match else "Unknown"
                        bucket["errors"][f"{rc}-{error_msg}"] += 1

        # Tampilkan Hasil Rolling Report
        print_hourly_summary(rolling_data, window_hours)

    except FileNotFoundError:
        print(f"File {log_file} tidak ditemukan.")

def print_hourly_summary(rolling_data, window_hours):
    header_label = f"Rolling Period ({window_hours}h)"
    print("="*90)
    print(f"{'HOURLY TRANSACTION PERFORMANCE REPORT':^90}")
    print("="*90)
    print(f"{header_label:<22} | {'Total':<6} | {'Success':<8} | {'Failed':<8} | {'SR %':<6} | {'Dominant Error'}")
    print("-" * 90)

    # Urutkan berdasarkan waktu
    for ts in sorted(rolling_data.keys()):
        data = rolling_data[ts]
        sr = (data['success'] / data['total'] * 100) if data['total'] > 0 else 0
        
        # Ambil error paling dominan di periode tersebut
        top_error = data['errors'].most_common(1)
        error_display = f"[{top_error[0][0]}]" if top_error else "-"
        
        # Beri tanda anomali jika SR < 95% (Sesuai target success rate Anda)
        alert = " [!]" if sr < 95 else ""
        
        # Format label waktu: "2026-04-14 08:00 - 09:00"
        end_time = ts.replace(hour=ts.hour + window_hours if ts.hour + window_hours < 24 else 23)
        time_label = f"{ts.strftime('%Y-%m-%d %H:00')}"
        
        print(f"{time_label:<22} | {data['total']:<6} | {data['success']:<8} | {data['failed']:<8} | {sr:>5.1f}%{alert:<4} | {error_display}")

    print("="*90)
    print("Peringatan [!] muncul jika Success Rate berada di bawah target 95%.")

if __name__ == "__main__":
    # Anda bisa mengganti window_hours ke 3, 6, atau 24 sesuai kebutuhan simulasi
    parse_hourly_rolling_logs("spring_boot_payment.log", window_hours=1)