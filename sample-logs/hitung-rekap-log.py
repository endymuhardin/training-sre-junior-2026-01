import re
from collections import Counter

def parse_payment_logs(log_file):
    # Regex untuk menangkap data penting: Level, Method, RC, dan Status
    # Format log: ... LEVEL ... : PAY_REQ | ID: ... | AMT: ... | MTD: {MTD} | RC: {RC} | STATUS: {STATUS}
    log_pattern = re.compile(r"MTD: (?P<method>\w+) \| RC: (?P<rc>\w+) \| STATUS: (?P<status>\w+)")

    total_count = 0
    success_count = 0
    failed_count = 0
    
    method_stats = Counter()
    error_distribution = Counter()

    try:
        with open(log_file, 'r') as file:
            for line in file:
                match = log_pattern.search(line)
                if match:
                    total_count += 1
                    status = match.group('status')
                    method = match.group('method')
                    rc = match.group('rc')

                    # Hitung Global Stats
                    if status == "SUCCESS":
                        success_count += 1
                    else:
                        failed_count += 1
                        # Rekap penyebab error berdasarkan RC (Response Code)
                        # Kita ambil pesan error setelah 'MSG: ' jika ada
                        msg_match = re.search(r"MSG: (.*)", line)
                        error_msg = msg_match.group(1) if msg_match else "Unknown Error"
                        error_distribution[f"{rc} - {error_msg}"] += 1

                    # Hitung statistik per metode
                    method_stats[method] += 1

        # Tampilkan Hasil Rekap
        print_summary(total_count, success_count, failed_count, method_stats, error_distribution)

    except FileNotFoundError:
        print(f"File {log_file} tidak ditemukan. Jalankan generator log terlebih dahulu.")

def print_summary(total, success, failed, methods, errors):
    success_rate = (success / total * 100) if total > 0 else 0
    
    print("="*60)
    print(f"{'REKAP TRANSAKSI PAYMENT':^60}")
    print("="*60)
    print(f"Total Transaksi   : {total}")
    print(f"Transaksi Sukses  : {success} ({success_rate:.2f}%)")
    print(f"Transaksi Gagal   : {failed} ({100 - success_rate:.2f}%)")
    print("-" * 60)
    
    print("\n[+] Distribusi Metode Pembayaran:")
    for m, count in methods.most_common():
        print(f" - {m:<15}: {count} trx")

    print("\n[+] Breakdown Error (Penyebab Kegagalan):")
    if not errors:
        print(" - Tidak ada error ditemukan.")
    for err, count in errors.most_common():
        print(f" - {err:<40}: {count} kali")
    print("="*60)

# Jalankan parser
if __name__ == "__main__":
    parse_payment_logs("spring_boot_payment.log")