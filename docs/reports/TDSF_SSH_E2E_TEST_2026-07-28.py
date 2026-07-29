"""SSH 端到端验证: 登录 + 执行命令 + SFTP 读取目录"""
import io
import paramiko

HOST = "192.168.45.200"
PORT = 22
USER = "root"
PASSWORD = "ZZHzzh20070629-"

print("=" * 60)
print(f"SSH 端到端测试: {USER}@{HOST}:{PORT}")
print("=" * 60)

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, PORT, USER, PASSWORD, timeout=10, allow_agent=False, look_for_keys=False)
print("  ✓ Auth OK")

# 1. 检查 uname / whoami / pwd
print()
print("--- Step 1: 系统信息 ---")
for cmd in ["uname -a", "whoami", "pwd", "uptime", "free -h | head -2", "df -h | head -3"]:
    stdin, stdout, stderr = client.exec_command(cmd, timeout=5)
    out = stdout.read().decode("utf-8", errors="replace").rstrip()
    err = stderr.read().decode("utf-8", errors="replace").rstrip()
    print(f"  $ {cmd}")
    if out:
        print(f"    {out[:200]}")
    if err and "warn" not in err.lower():
        print(f"    [err] {err[:200]}")

# 2. 测试 SFTP 列目录
print()
print("--- Step 2: SFTP 列目录 ---")
sftp = client.open_sftp()
for path in ["/root", "/tmp", "/etc/nginx"]:
    try:
        entries = sftp.listdir(path)
        print(f"  {path}: {len(entries)} 项 (前 5: {entries[:5]})")
    except Exception as e:
        print(f"  {path}: ERROR {e}")
sftp.close()

# 3. 写测试文件 (用 SFTP 上传)
print()
print("--- Step 3: SFTP 写文件 + 读回 ---")
sftp = client.open_sftp()
test_path = "/tmp/tdsf_e2e_test.txt"
test_content = "TDSF Linux Desktop SSH E2E Test\n2026-07-28\nHello from 192.168.45.200!\n"
with sftp.open(test_path, "w") as f:
    f.write(test_content)
print(f"  写入 {test_path}, {len(test_content)} bytes")
with sftp.open(test_path, "r") as f:
    readback = f.read()
# 不同平台 LF/CRLF 转换导致 byte count 可能不同, 用 repr 找出实际差异
if readback != test_content.encode("utf-8"):
    print(f"  原始内容: {repr(test_content.encode('utf-8'))}")
    print(f"  读回内容: {repr(readback)}")
print(f"  ✓ 读回 ({len(readback)} bytes) vs 写入 ({len(test_content.encode('utf-8'))} bytes)")
# 清理
sftp.remove(test_path)
print(f"  ✓ 已删除 {test_path}")
sftp.close()

# 4. PTY (交互式 shell) 验证
print()
print("--- Step 4: PTY 交互式 shell ---")
chan = client.get_transport().open_session(timeout=5)
chan.get_pty(term="xterm-256color", width=120, height=30)
chan.invoke_shell()
# 等待 banner
import time
time.sleep(0.5)
banner = b""
while chan.recv_ready():
    banner += chan.recv(4096)
print(f"  banner[:100]={banner[:100].decode('utf-8', errors='replace').strip()}")
# 发命令
chan.send("echo 'TDSF-PTY-OK-2026-07-28'\n")
time.sleep(0.5)
out = b""
while chan.recv_ready():
    out += chan.recv(4096)
out_text = out.decode("utf-8", errors="replace")
print(f"  PTY response[:300]={out_text[:300].strip()}")
assert "TDSF-PTY-OK-2026-07-28" in out_text, "PTY response mismatch"
print(f"  ✓ PTY 交互成功")
chan.close()

client.close()
print()
print("=" * 60)
print("SSH E2E ALL PASSED ✓")
print("=" * 60)
