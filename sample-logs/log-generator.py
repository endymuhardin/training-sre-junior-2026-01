import random
import uuid
from datetime import datetime, timedelta

def generate_spring_boot_logs(total_lines=1000, success_rate=0.95, filename="spring_boot_payment.log"):
    """
    Generator log dengan format Spring Boot (Teks).
    
    :param total_lines: Jumlah baris log yang ingin dihasilkan.
    :param success_rate: Persentase sukses (0.0 - 1.0).
    :param filename: Nama file output.
    """
    
    # Konfigurasi Variabel
    methods = ["QRIS", "VA_BCA", "VA_BSI", "VA_MANDIRI", "CREDIT_CARD", "GOPAY", "OVO"]
    loggers = [
        "c.t.payment.service.PaymentService",
        "c.t.payment.controller.PaymentController",
        "c.t.payment.gateway.BankConnector"
    ]
    
    # Distribusi jenis error (RC: Response Code)
    # Anda bisa menambah atau mengurangi bobot error di sini
    error_pool = [
        {"rc": "51", "msg": "Insufficient Funds", "level": "WARN"},
        {"rc": "68", "msg": "Upstream Bank Timeout", "level": "ERROR"},
        {"rc": "55", "msg": "Invalid PIN / OTP", "level": "WARN"},
        {"rc": "96", "msg": "System Malfunction (ISO-8583 Error)", "level": "ERROR"},
        {"rc": "61", "msg": "Daily Velocity Limit Exceeded", "level": "WARN"},
        {"rc": "05", "msg": "Do Not Honor (Suspected Fraud)", "level": "ERROR"}
    ]

    start_date = datetime(2026, 4, 14, 8, 0, 0)
    
    with open(filename, "w") as f:
        for i in range(total_lines):
            # 1. Tentukan status (Success/Fail)
            is_success = random.random() < success_rate
            
            # 2. Generate metadata log
            # Sebaran waktu dalam 7 hari (10080 menit)
            timestamp = start_date + timedelta(minutes=random.randint(0, 10080), seconds=random.randint(0, 59))
            formatted_time = timestamp.strftime("%Y-%m-%d %H:%M:%S")
            
            trace_id = f"tr-{random.randint(100, 999)}"
            span_id = uuid.uuid4().hex[:8]
            thread_name = f"nio-8080-exec-{random.randint(1, 10)}"
            logger = random.choice(loggers)
            
            # 3. Generate data transaksi
            txn_id = f"TXN-{20000 + i}"
            amount = random.choice([10000, 25000, 50000, 100000, 500000, 1000000, 2500000])
            method = random.choice(methods)
            
            if is_success:
                level = "INFO"
                rc = "00"
                status = "SUCCESS"
                msg_part = ""
            else:
                err = random.choice(error_pool)
                level = err["level"]
                rc = err["rc"]
                status = "FAILED"
                msg_part = f" | MSG: {err['msg']}"
            
            # 4. Susun format baris Spring Boot
            # Format: Date Time Level [Service,TraceId,SpanId] Thread --- Logger : Message
            log_line = f"{formatted_time} {level:>5} [pay-svc,{trace_id},{span_id}] 14210 --- [{thread_name:>15}] {logger:<40} : PAY_REQ | ID: {txn_id} | AMT: {amount} | MTD: {method} | RC: {rc} | STATUS: {status}{msg_part}\n"
            
            f.write(log_line)

    print(f"Generated {total_lines} lines of logs in '{filename}' (Success Rate: {success_rate*100}%)")

# --- Eksekusi ---
# Anda bisa memvariasikan jumlah log dan rate di sini
generate_spring_boot_logs(total_lines=5000, success_rate=0.95)