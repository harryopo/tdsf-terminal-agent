# 三级Linux考证 · 复习资料（精选版）

> 基于已学项目1-14 + 官方样题，筛选考试高频考点，去掉不考的内容，补充未学考点
> 编制时间：2026-06-28
> 考试日期：2026-09-19

---

## 📊 考试结构与复习策略

### 题型分值

| 题型 | 题数 | 分值 | 答题方式 |
|------|------|------|---------|
| 单项选择题 | 40题 | 每题1分 = 40分 | 点选ABCD |
| 填空题 | 10题 | 每题2分 = 20分 | 文本框填命令/参数 |
| 综合题 | 2题 | 每题20分 = 40分 | 文本框写Shell脚本/命令 |

### 已学内容筛选对照表

| 已学项目 | 考试考不考 | 考试中的分值 | 复习策略 |
|---------|-----------|------------|---------|
| 项目1 破解密码 | ❌ 不考 | 0分 | 跳过 |
| 项目2 文件管理 | ✅ 高频 | ~8分 | 重点复习 |
| 项目3 yum/vim | ✅ 考 | ~4分 | 重点复习 |
| 项目4 用户管理 | ✅ 高频 | ~5分 | 重点复习 |
| 项目5 权限管理 | ✅ 高频 | ~4分 | 重点复习 |
| 项目6 搜索/打包 | ✅ 考 | ~3分 | 复习tar/find |
| 项目7 网络/Samba | ✅ 考网络部分 | ~4分 | 复习网络命令 |
| 项目8 磁盘管理 | ✅ 高频 | ~6分 | 重点复习 |
| 大下1 环境变量 | ✅ 考 | ~2分 | 复习export/source |
| 大下2 sed | ✅ 考 | ~2分 | 复习sed替换 |
| 大下3 SSH | ✅ 高频 | ~4分 | 重点复习 |
| 大下4 scp/rsync | ✅ 考scp | ~2分 | 复习scp |
| 大下5 日志 | ✅ 考 | ~2分 | 复习/var/log |
| 大下6 parted | ⚠️ 可能考 | ~1分 | 简单了解 |
| 大下7 LVM | ❌ 基本不考 | 0分 | 跳过 |
| 大下8 VDO | ❌ 不考 | 0分 | 跳过 |
| 大下9-10 NFS | ❌ 基本不考 | 0分 | 跳过 |
| 项目11 SELinux | ⚠️ 可能考 | ~1分 | 简单了解 |
| 项目12 防火墙 | ⚠️ 可能考 | ~1分 | 简单了解 |
| 项目13 进程/计划任务 | ✅ 高频 | ~4分 | 重点复习 |
| 项目14 性能调优 | ✅ 考nice/renice | ~2分 | 复习优先级 |
| 项目15 Shell脚本 | ✅ 必考综合题 | 20分 | **重中之重** |

### 需要额外补充的考点（没学过但考试考）

| 考点 | 考试分值 | 来源 |
|------|---------|------|
| 操作系统理论（冯诺依曼/进程状态） | ~3分 | 选择题+填空题 |
| Emacs编辑器基础 | ~2分 | 选择题 |
| GCC编译器 | ~3分 | 选择题+填空题+综合题 |
| GDB调试器 | ~2分 | 选择题+综合题 |
| Make/Makefile | ~2分 | 选择题 |
| 系统调用（open/read/write/close） | ~3分 | 选择题 |
| 信号（SIGTERM/SIGKILL） | ~2分 | 选择题 |
| 管道通信 | ~1分 | 选择题 |

---

## 第一部分：已学内容精选复习（选择题+填空题高频考点）

### 1.1 Linux基础命令

#### ls 命令（项目2·高频）

```bash
ls -l     # long format，长格式显示
ls -a     # all，显示隐藏文件（以.开头的文件）
ls -ld    # directory，只显示目录本身属性，不列出内容
ls -R     # recursive，递归列出子目录
ls -i     # inode，显示inode号
ls -Z     # context，显示SELinux安全上下文
```

**考试真题**：`ls -l` 输出中第一个字符代表文件类型：
- `-` 普通文件
- `d` 目录
- `l` 软链接（link）
- `b` 块设备（block device，如硬盘）
- `c` 字符设备（character device，如串口）
- `p` 管道文件（pipe）

#### 通配符（项目2·选择题高频）

| 通配符 | 含义 | 例子 | 匹配结果 |
|--------|------|------|---------|
| `*` | 匹配任意数量字符 | `ls chapter*` | chapter, chapter1, chapter123 |
| `?` | 匹配单个字符 | `ls chapter?` | chapter1, chapter2（不匹配chapter） |
| `[0-9]` | 匹配数字范围 | `ls chapter[0-9]*` | chapter1, chapter123（不匹配chapter） |
| `[a-z]` | 匹配小写字母 | `ls file[a-z]` | filea, fileb |

**考试真题**：`ls chapter[0-9]*` 的结果是？
> 答案：chapter1 chapter123（以chapter开头，后跟至少一个数字）

#### cd 命令（项目2）

| 命令 | 含义 |
|------|------|
| `cd /` | 到根目录 |
| `cd ~` 或 `cd` | 到用户home目录 |
| `cd ..` | 到上一级目录 |
| `cd -` | 到上一次所在的目录 |

#### 权限管理（项目5·选择题高频）

**数字权限**：

| 数字 | 权限 | 英文 | 二进制 |
|------|------|------|--------|
| 4 | 读 | read | r-- |
| 2 | 写 | write | -w- |
| 1 | 执行 | execute | --x |
| 0 | 无权限 | none | --- |

**常见权限组合**：

| 数字 | 权限 | 含义 |
|------|------|------|
| 755 | rwxr-xr-x | 所有者全权限，其他人读+执行 |
| 644 | rw-r--r-- | 所有者读写，其他人只读 |
| 600 | rw------- | 仅所有者读写 |
| 777 | rwxrwxrwx | 所有人全权限（危险！） |

**考试真题**：文件所有者有读写权限，同组和其他用户只读，权限应设为？
> 答案：644（rw-r--r--）

**符号权限**：

| 字母 | 英文 | 含义 |
|------|------|------|
| u | user | 所有者 |
| g | group | 所属组 |
| o | other | 其他用户 |
| a | all | 所有用户 |
| + | add | 添加权限 |
| - | remove | 移除权限 |
| = | set | 设置为指定权限 |

```bash
chmod o+x file     # 给其他用户加执行权限
chmod u-w file     # 去掉所有者的写权限
chmod a=r file     # 所有人只读
```

#### 软链接（项目2·选择题高频）

```bash
ln -s 源文件 链接名    # 创建软链接（symbolic link）
```

**`ls -l` 识别软链接**：
```
lrwxr--r-- 1 stu users 2024 Sep 12 08:12 cheng -> /home/orig
↑
l 表示软链接
```

#### 文件操作（项目2）

```bash
cp -r dir1 dir2      # recursive，递归复制目录
cp -a dir1 dir2      # archive，保留属性递归复制
mv file1 file2       # 重命名/移动
rm -rf dir           # force + recursive，强制递归删除
mkdir -p a/b/c       # parents，递归创建目录
```

---

### 1.2 用户管理（项目4·选择题高频）

#### 核心命令

```bash
useradd -u 1000 -d /home/user1 -s /bin/bash -G group1 user1
#        -u UID   -d home目录    -s shell       -G 附加组

userdel -r user1     # -r 删除用户同时删除home目录
usermod -G group1 user1   # 修改用户所属组
passwd user1         # 设置密码
passwd --stdin user1 # 从标准输入读取密码（免交互）
id user1             # 查看用户UID/GID/组信息
```

**考试真题**：哪个参数删除用户同时删除home目录？
> 答案：`userdel -r`

**考试真题**：创建用户后，home目录在哪个目录下？
> 答案：`/home`

#### 用户配置文件

| 文件 | 作用 | 格式 |
|------|------|------|
| `/etc/passwd` | 用户基本信息 | `用户名:x:UID:GID:描述:home目录:shell` |
| `/etc/shadow` | 用户密码（加密） | `用户名:加密密码:最后修改:最小间隔:最大间隔:警告:过期:禁用` |
| `/etc/group` | 用户组信息 | `组名:x:GID:组成员` |

**/etc/passwd 各字段**：
```
user1:x:1000:1000::/home/user1:/bin/bash
  ↑    ↑   ↑    ↑    ↑       ↑          ↑
用户名 密码 UID  GID  描述    home目录    shell
```

**禁止用户登录**：将shell改为 `/sbin/nologin`

---

### 1.3 进程管理（项目13·选择题高频）

#### 查看进程

```bash
ps aux       # a=all, u=user, x=无终端进程 → BSD格式
ps -ef       # -e=all, -f=full → System V格式
ps -l        # long format，长格式
top          # 实时显示进程，按P排序CPU，按M排序内存
```

**ps aux 输出各列**：
```
USER  PID  %CPU  %MEM   VSZ    RSS   TTY  STAT  START  TIME  COMMAND
```

**考试真题**：ps哪个参数显示所有用户的进程？
> 答案：`a`（不是u也不是x，a = all users）

#### 终止进程

```bash
kill -9 PID          # -9 = SIGKILL，强制终止
kill -15 PID         # -15 = SIGTERM，优雅终止（默认）
killall 进程名       # 按名字杀所有同名进程
killall -u user1     # 杀掉指定用户的所有进程
```

**考试真题**：哪个命令可以终止一个用户的所有进程？
> 答案：`killall`

#### 进程优先级

```bash
nice -n 10 command    # 启动时设置优先级（nice值范围-20到19，越小优先级越高）
renice -n 5 -p PID    # 修改已运行进程的优先级
```

**考试真题**：应用程序启动时设置进程优先级用哪个命令？
> 答案：`nice`

**注意**：普通用户只能调高nice值（降低优先级），只有root能调低nice值（提高优先级）

---

### 1.4 磁盘与文件系统（项目8·选择题高频）

#### 磁盘分区

```bash
fdisk -l             # 列出所有磁盘分区
fdisk /dev/sda       # 对sda进行分区操作
```

**Linux磁盘命名**：

| 设备名 | 含义 |
|--------|------|
| `/dev/hda` | 第一块IDE磁盘 |
| `/dev/sda` | 第一块SCSI/SATA磁盘 |
| `/dev/nvme0n1` | 第一块NVMe固态硬盘 |
| `/dev/sda1` | sda的第一个分区 |

**考试真题**：Linux中第一块IDE磁盘的名字为？
> 答案：`/dev/hda`

**设备分类**：
- 块设备（block device）：硬盘、U盘 → 随机访问
- 字符设备（character device）：串口、终端 → 顺序访问

#### 文件系统操作

```bash
mkfs -t xfs /dev/sda1     # 创建xfs文件系统
mkfs -t ext4 /dev/sda1    # 创建ext4文件系统
mount /dev/sda1 /mnt      # 挂载分区到/mnt
umount /mnt               # 卸载
mount -a                  # 挂载/etc/fstab中所有文件系统
```

**考试真题**：挂载所有在/etc/fstab中定义的文件系统用什么命令？
> 答案：`mount -a`

#### 磁盘使用查看

```bash
df -h          # human-readable，显示磁盘使用情况
df -i          # inode，显示inode使用情况
df -Th         # 显示文件系统类型
du -sh /home   # 显示/home目录总大小
free -h        # 显示内存和swap使用情况
```

**考试真题**：显示各分区inode使用情况用哪个命令？
> 答案：`df -i`

**考试真题**：查看swap空间使用情况用哪个命令？
> 答案：`free`

#### 交换分区

```bash
mkswap /dev/sda2     # 创建swap分区
swapon /dev/sda2     # 启用swap
swapon -s            # 查看swap状态
swapoff /dev/sda2    # 关闭swap
```

#### /etc/fstab 自动挂载

```
设备名    挂载点    文件系统类型    挂载选项    dump    fsck顺序
/dev/sda1  /mnt      xfs           defaults    0       0
```

---

### 1.5 网络管理（项目7·选择题高频）

#### 网络配置命令

```bash
ifconfig              # 显示/配置网络接口
ip addr               # 显示IP地址
hostname              # 显示主机名
ping -c 4 192.168.1.1 # 发送4个ping包
nmcli                 # NetworkManager命令行工具
nmtui                 # NetworkManager文本界面
```

**考试真题**：列出所有当前活跃的网络接口用哪个命令？
> 答案：`ifconfig`

**考试真题**：确定两台机器间底层IP连接性用哪个命令？
> 答案：`ping`

**考试真题**：显示当前主机名用哪个命令？
> 答案：`hostname`

**考试真题**：Linux以太网网络接口的命名格式？
> 答案：`eth0`、`eth1`、`eth2`（eth + 数字）

#### 网络接口启停

```bash
ifup eth0       # 启用网络接口（DHCP动态获取IP）
ifdown eth0     # 关闭网络接口（释放IP）
```

**考试真题**：DHCP机器用什么命令增加/减少网络接口？
> 答案：`ifup`、`ifdown`

#### 常用服务端口

| 服务 | 端口 | 协议 |
|------|------|------|
| SSH | 22 | TCP |
| HTTP | 80 | TCP |
| HTTPS | 443 | TCP |
| DNS | 53 | TCP/UDP |
| FTP | 20(数据)/21(控制) | TCP |
| Samba | 139/445 | TCP |

**考试真题**：DNS服务使用的端口是？
> 答案：`53`

---

### 1.6 vim编辑器（项目3·选择题+填空题高频）

#### 三种工作模式

```
命令模式 ←→ 输入模式
    ↓
末行模式（:）
```

| 模式切换 | 按键 |
|---------|------|
| 命令→输入 | i（插入）, a（追加）, o（下方新行）, O（上方新行） |
| 输入→命令 | Esc |
| 命令→末行 | : （冒号） |
| 末行→命令 | Esc |

#### 常用命令

| 按键 | 含义 | 英文 |
|------|------|------|
| `dd` | 删除整行 | delete |
| `4dd` | 删除4行 | 4 delete |
| `yy` | 复制整行 | yank |
| `4yy` | 复制4行 | 4 yank |
| `p` | 粘贴 | paste |
| `u` | 撤销 | undo |
| `Ctrl+r` | 重做 | redo |
| `gg` | 跳到第一行 | go |
| `G` | 跳到最后一行 | Go |
| `:wq` | 保存退出 | write quit |
| `:q!` | 不保存退出 | quit force |
| `:set nu` | 显示行号 | number |
| `:set nonu` | 取消行号 | no number |

**考试真题**：vim中"4 lines yanked"提示，输入的命令是？
> 答案：`4yy`

#### vim替换命令（填空题高频）

```
:范围s/旧文本/新文本/选项
```

| 命令 | 含义 |
|------|------|
| `:1,$s/abc/efg/g` | 全文替换abc为efg（g=global全局） |
| `:10,15s/abc/efg/` | 10-15行每行替换第一个abc |
| `:10,15s/abc/efg/g` | 10-15行所有abc都替换 |
| `:%s/This/That/g` | 全文替换This为That |

**考试真题**：把10-15行中第一个'abc'替换为'efg'，命令是？
> 答案：`:10,15s/abc/efg`

---

### 1.7 SSH远程登录（大下项目3·选择题+综合题高频）

#### SSH命令

```bash
ssh user1@192.168.1.100          # 远程登录
ssh -p 2222 user1@192.168.1.100  # 指定端口
scp file.txt user1@192.168.1.100:/tmp/  # 上传文件
scp user1@192.168.1.100:/tmp/file.txt . # 下载文件
scp -r dir user1@host:/tmp/      # 递归传输目录
```

**考试真题**：SSH是什么协议？
> 答案：安全外壳（Secure Shell）协议

**考试真题**：为远程登录会话和其他网络服务提供安全性的协议是？
> 答案：SSH

#### SSH免密登录

```bash
ssh-keygen -t rsa        # 生成密钥对
ssh-copy-id user1@host   # 将公钥复制到远程主机
```

#### SSH配置文件

| 文件 | 作用 |
|------|------|
| `/etc/ssh/sshd_config` | SSH服务端配置 |
| `~/.ssh/authorized_keys` | 存放公钥（免密登录） |
| `~/.ssh/id_rsa` | 私钥 |
| `~/.ssh/id_rsa.pub` | 公钥 |

---

### 1.8 Shell脚本编程（项目15·综合题20分必考）

#### Shebang声明

```bash
#!/bin/bash    # 告诉系统用bash解释器执行
```

#### 变量

```bash
# 变量赋值（等号两边不能有空格！）
name="张三"
count=10

# 变量引用
echo $name
echo ${name}

# 命令替换
date=$(date +%Y%m%d)    # $()方式
date=`date +%Y%m%d`     # 反引号方式

# 环境变量
export PATH=$PATH:/new/path   # 设置环境变量
source ~/.bashrc              # 使配置立即生效
```

**考试真题**：已知nu=aaa，想让nu=aaabbb，应执行nu=？
> 答案：`${nu}bbb`

**考试真题**：临时改变为root身份用什么命令？
> 答案：`su`

#### 输入输出

```bash
# 从键盘读取
read -p "请输入：" var        # -p 提示信息
read -t 30 var               # -t 超时30秒
read -s var                  # -s 静默模式（输入不显示，用于密码）

# 输出
echo "Hello"                 # 普通输出
echo -e "line1\nline2"      # -e 启用转义字符
```

#### 位置参数

```bash
# 脚本执行：bash script.sh arg1 arg2 arg3
$0    # 脚本名
$1    # 第一个参数
$2    # 第二个参数
$#    # 参数个数
$@    # 所有参数
```

#### 条件判断

```bash
# 数字比较
if [ $a -eq $b ]    # equal 等于
if [ $a -ne $b ]    # not equal 不等于
if [ $a -gt $b ]    # greater than 大于
if [ $a -lt $b ]    # less than 小于
if [ $a -ge $b ]    # greater or equal 大于等于
if [ $a -le $b ]    # less or equal 小于等于

# 字符串比较
if [ "$str1" == "$str2" ]   # 字符串相等
if [ -z "$str" ]            # 字符串为空
if [ -n "$str" ]            # 字符串非空

# 文件判断
if [ -f file ]     # 是普通文件
if [ -d dir ]      # 是目录
if [ -e file ]     # 文件存在
if [ -r file ]     # 可读
if [ -w file ]     # 可写
if [ -x file ]     # 可执行
```

#### 循环

```bash
# for循环
for i in 1 2 3 4 5
do
    echo $i
done

# for循环+seq
for i in $(seq 1 10)
do
    echo $i
done

# while循环
while [ $i -le 10 ]
do
    echo $i
    i=$(($i + 1))
done

# 无限循环
while :
do
    echo "running..."
done
```

#### 算术运算

```bash
sum=$(($a + $b))     # 加法
diff=$(($a - $b))    # 减法
prod=$(($a * $b))    # 乘法
quot=$(($a / $b))    # 除法
mod=$(($a % $b))     # 取余
```

#### 管道与重定向

```bash
command1 | command2     # 管道：command1的输出作为command2的输入
command > file          # 标准输出重定向到file（覆盖）
command >> file         # 标准输出追加重定向到file
command 2> file         # 标准错误重定向到file
command > file 2>&1     # 标准错误重定向到标准输出，再一起重定向到file
command < file          # 标准输入重定向，从file读取
```

**考试真题**：在命令后加入 `2>&1`，表示？
> 答案：标准错误输出重定向到标准输出

**考试真题**：管道符是什么？
> 答案：`|`（竖杠），用来连接多条命令

---

### 1.9 日志管理（大下项目5）

#### 日志文件位置

| 文件 | 内容 |
|------|------|
| `/var/log/messages` | 系统主日志 |
| `/var/log/secure` | 安全/认证日志 |
| `/var/log/cron` | 定时任务日志 |
| `/var/log/maillog` | 邮件日志 |
| `/var/log/audit/audit.log` | SELinux审计日志 |

**考试真题**：Linux日志文件通常保存在？
> 答案：`/var/log`

#### 日志命令

```bash
tail -f /var/log/messages    # 实时跟踪日志
journalctl -u sshd           # 查看sshd服务日志
journalctl --since today     # 查看今天的日志
logger -p info "test msg"    # 手动发送日志
```

---

### 1.10 软件包管理（项目3）

#### 软件包分类

| 类型 | 特点 | 安装方式 |
|------|------|---------|
| 源码包 | 需要编译，可定制 | `./configure && make && make install` |
| 二进制包（RPM） | 预编译，直接安装 | `rpm -ivh package.rpm` 或 `yum install` |

**考试真题**：Linux软件包分为两种，除了二进制包还有？
> 答案：源码包

#### yum命令

```bash
yum install package      # 安装
yum remove package       # 卸载
yum list installed       # 列出已安装
yum repolist             # 列出仓库
yum grouplist            # 列出软件组
yum provides */command   # 查找命令属于哪个包
yum clean all            # 清除缓存
```

#### rpm命令

```bash
rpm -ivh package.rpm    # install安装
rpm -e package          # erase卸载
rpm -qa                 # 查询所有已安装
rpm -qi package         # 查询包信息
rpm -ql package         # 查询包安装了哪些文件
```

---

### 1.11 其他已学考点

#### httpd服务（项目11/12涉及）

```bash
systemctl start httpd       # 启动Apache
systemctl enable httpd      # 开机自启
systemctl status httpd      # 查看状态
```

**考试真题**：Linux终端启动Apache的命令为？
> 答案：`service httpd start`

**httpd配置文件**：`/etc/httpd/conf/httpd.conf`
**网站根目录**：`/var/www/html`

#### 文件搜索（项目6）

```bash
find / -name "*.conf" -type f       # 按名字搜索
find / -user root -type f           # 按用户搜索
find / -mtime -1                    # 1天内修改的文件
find / -size +100M                  # 大于100MB的文件
find / -name "*.log" -exec rm {} \; # 找到后执行删除
```

#### 打包压缩（项目6）

```bash
tar -cvf archive.tar dir/      # 打包（不压缩）
tar -czf archive.tar.gz dir/   # 打包+gzip压缩
tar -cjf archive.tar.bz2 dir/  # 打包+bzip2压缩
tar -xvf archive.tar           # 解包
tar -xzvf archive.tar.gz       # 解包+解压gzip
tar -xjf archive.tar.bz2       # 解包+解压bzip2
tar -tf archive.tar            # 查看内容（不解包）
```

#### sed命令（大下项目2）

```bash
sed 's/old/new/g' file         # 全局替换
sed -i 's/old/new/g' file      # 直接修改文件
sed -n '5p' file               # 只打印第5行
sed '5d' file                  # 删除第5行
sed '5a\new line' file         # 在第5行后追加
```

---

## 第二部分：未学考点补充（考试必考但你没学过）

### 2.1 操作系统理论（~3分）

#### 冯诺依曼体系结构

```
CPU = 运算器 + 控制器
内存 = 存储器
输入设备 + 输出设备 = I/O设备
```

**考试真题**：冯诺依曼体系结构中，CPU由运算器和______组成？
> 答案：控制器（Control Unit）

#### 操作系统四大功能

| 功能 | 英文 | 说明 |
|------|------|------|
| 进程管理 | Process Management | CPU调度、进程创建/终止、进程通信 |
| 内存管理 | Memory Management | 内存分配/回收、虚拟内存、页面置换 |
| 文件管理 | File Management | 文件创建/删除/读写、目录管理、权限控制 |
| 设备管理 | Device Management | 设备驱动、中断处理、DMA |

**考试真题**：操作系统负责管理计算机系统的______？
> 答案：资源（Resources）

#### 进程三状态

```
    就绪(Ready) ←──调度──→ 运行(Running)
         ↑                      │
         │                      │ 等待事件
         │                      ↓
         └──────── 阻塞(Blocked)
                   事件完成
```

| 状态 | 英文 | 含义 |
|------|------|------|
| 就绪 | Ready | 等待CPU分配 |
| 运行 | Running | 正在CPU上执行 |
| 阻塞 | Blocked/Waiting | 等待I/O或事件 |

#### Linux特点

| 特点 | 说明 |
|------|------|
| 开源 | 源代码公开 |
| 多用户 | 多个用户同时使用 |
| 多任务 | 多个程序同时运行 |
| 多平台 | 支持多种硬件架构 |
| 稳定 | 可长期不关机运行 |

**注意**：Solaris属于Unix家族，不属于Linux家族。Linux家族包括Ubuntu、CentOS、Red Hat、Debian等。

---

### 2.2 Emacs编辑器（~2分）

Emacs是另一个编辑器，和vim是竞争对手。

#### 基本操作

| 操作 | 按键 | 对比vim |
|------|------|---------|
| 向前翻一屏 | Ctrl+v | Ctrl+f |
| 向后翻一屏 | Alt+v | Ctrl+b |
| 保存文件 | Ctrl+x然后Ctrl+s | :w |
| 退出 | Ctrl+x然后Ctrl+c | :q |
| 保存退出 | Ctrl+x然后Ctrl+s再Ctrl+x然后Ctrl+c | :wq |

#### 模式行

Emacs底部有模式行，其中显示模式字段：
- `%%` = 只读缓冲区，文本未修改
- `**` = 缓冲区已修改
- `--` = 缓冲区可写，文本未修改

**考试真题**：Emacs中模式行显示"%%"表示？
> 答案：只读缓冲区，且文本未被修改

**考试真题**：Emacs中将光标向前移动一屏的命令是？
> 答案：Ctrl+v

#### set report设置（vim）

**考试真题**：vim中想在每次编辑时都收到反馈信息，应输入？
> 答案：`:set report=0`

---

### 2.3 GCC编译器（~3分）

#### GCC编译流程

```
源码(.c) → 预处理 → 编译 → 汇编 → 链接 → 可执行文件
```

#### GCC常用选项

| 选项 | 英文 | 含义 |
|------|------|------|
| `-o` | output | 指定输出文件名 |
| `-c` | compile | 只编译不链接，生成.o目标文件 |
| `-g` | debug | 产生调试信息（供GDB使用） |
| `-Wall` | Warnings all | 显示所有警告 |
| `-O` | Optimize | 优化代码（O1/O2/O3） |
| `-I` | Include | 指定头文件搜索路径 |
| `-L` | Library path | 指定库文件搜索路径 |
| `-l` | link | 链接指定库（如-lm链接数学库） |

**考试真题**：GCC在默认路径找库文件，用哪个选项指定额外库文件路径？
> 答案：`-L`

**考试真题**：gcc编译test.c，输出mytest，产生调试信息，命令是？
> 答案：`gcc -g test.c -o mytest`

---

### 2.4 GDB调试器（~2分）

#### GDB常用命令

| 命令 | 全称 | 含义 |
|------|------|------|
| `gdb program` | - | 启动调试 |
| `break 行号` | breakpoint | 设置断点 |
| `run` | run | 开始执行 |
| `next` | next | 单步执行（不进入函数） |
| `step` | step | 单步执行（进入函数） |
| `continue` | continue | 继续执行到下一个断点 |
| `print 变量` | print | 打印变量值 |
| `whatis 变量` | what is | 查看变量类型 |
| `info break` | info | 查看断点信息 |
| `delete 编号` | delete | 删除断点 |
| `kill` | kill | 终止调试程序 |
| `quit` | quit | 退出GDB |

**考试真题**：GDB中查看变量类型用什么命令？
> 答案：`whatis`

**考试真题**：GDB中在程序第3行设置断点，命令是？
> 答案：`break 3`

---

### 2.5 Make/Makefile（~2分）

#### Makefile基本结构

```makefile
目标: 依赖文件
    生成命令
```

**例子**：
```makefile
mytest: test.c
    gcc -g test.c -o mytest
```

#### make工作原理

1. 读取Makefile文件
2. 比较目标文件和依赖文件的时间戳
3. 如果依赖文件比目标文件新，则执行生成命令
4. 如果目标文件已是最新，则不执行

**考试真题**：关于make命令，说法错误的是？
> "makefile文件中目标文件后面跟的是源文件，最后是生成源文件的命令" → 错误！
> 应该是"最后是生成**目标文件**的命令"，不是"生成源文件的命令"

---

### 2.6 系统调用（~3分）

#### 常用系统调用

| 系统调用 | 含义 | 说明 |
|---------|------|------|
| `open()` | 打开文件 | 返回文件描述符(fd) |
| `read()` | 读文件 | 返回实际读取的字节数 |
| `write()` | 写文件 | 返回实际写入的字节数 |
| `close()` | 关闭文件 | 释放文件描述符 |
| `lseek()` | 移动文件指针 | 改变读写位置 |

#### open()的标志

| 标志 | 英文 | 含义 |
|------|------|------|
| O_RDONLY | Read Only | 只读 |
| O_WRONLY | Write Only | 只写 |
| O_RDWR | Read Write | 读写 |
| O_CREAT | Create | 不存在则创建 |
| O_APPEND | Append | 追加写入 |

**考试真题**：O_WRONLY表示？
> 答案：以只写方式打开文件

**考试真题**：write成功时返回？
> 答案：实际写入的字节数

#### 错误码

| 错误码 | 含义 |
|--------|------|
| ENOENT | Error No Entry → 无此文件或目录 |
| EACCES | Error Access → 权限不足 |
| EBADF | Error Bad File Descriptor → 文件描述符无效 |
| EIO | Error I/O → 输入/输出错误 |

**考试真题**：ENOENT的含义是？
> 答案：无此文件或目录

---

### 2.7 信号（~2分）

#### 常见信号

| 信号 | 编号 | 含义 | 能否被捕获 |
|------|------|------|-----------|
| SIGHUP | 1 | 挂起（终端断开） | 能 |
| SIGINT | 2 | 中断（Ctrl+C） | 能 |
| SIGKILL | 9 | 强制杀死 | **不能** |
| SIGTERM | 15 | 终止（优雅退出） | 能 |
| SIGSTOP | 19 | 暂停 | **不能** |

**考试真题**：SIGTERM信号常用于？
> 答案：让进程执行清理操作后终止

**kill -9 vs kill -15**：
- `kill -9`（SIGKILL）：强制杀死，进程无法捕获，立即终止
- `kill -15`（SIGTERM）：优雅终止，进程可以捕获并执行清理

---

### 2.8 管道通信（~1分）

#### 管道的特点

- 管道是**半双工**的（数据只能单向流动）
- 管道有**读端**和**写端**两个文件描述符
- 管道通信结束后需要**close()**释放资源
- 管道本质是内核中的一块缓冲区

**考试真题**：管道通信结束后，需要对管道文件描述符执行什么操作？
> 答案：`close()`

---

## 第三部分：综合题专项训练

### 3.1 综合题题型分析

综合题固定2道，每道20分：

| 题型 | 考点 | 分值 |
|------|------|------|
| 操作题 | mkdir/chmod/vim/scp/ssh/gcc/gdb组合操作 | 20分 |
| 编程题 | Shell脚本编写（填空形式） | 20分 |

### 3.2 操作题模板

**典型流程**：创建目录→复制文件→修改权限→vim编辑→scp传输→ssh登录→gcc编译→gdb调试

```bash
# 1. 创建目录
mkdir /tmp/target

# 2. 进入目录
cd /tmp/target

# 3. 复制文件
cp /tmp/source/test.c .

# 4. 修改权限（只读→可写）
chmod a+rw test.c

# 5. vim编辑
vi test.c

# 6. vim内全文替换
:1,$s/This/That/g

# 7. vim内删除第4行
dd

# 8. 保存退出
:wq

# 9. scp上传
scp /tmp/target/test.c user1@10.0.0.50:/tmp/

# 10. ssh登录
ssh user1@10.0.0.50

# 11. gcc编译（带调试信息）
gcc -g test.c -o mytest

# 12. gdb调试
gdb mytest

# 13. 设置断点
break 3
```

### 3.3 Shell脚本编程模板

**必考题型**：猜数字游戏（while + read + if + 随机数）

```bash
#!/bin/bash                         # shebang声明
m=`echo $RANDOM`                    # 生成随机数
n1=$[ $m % 100 ]                   # 取模得到0-99
while :                             # 无限循环
do
    read -p "Please input: " n      # 读取用户输入
    if [ $n == $n1 ]                # 判断是否猜中
    then
        break                       # 猜中跳出循环
    elif [ $n -gt $n1 ]             # 判断是否太大
    then
        echo "bigger"
        continue                    # 继续循环
    else
        echo "smaller"
        continue
    fi
done
echo "You are right."              # 输出成功提示
```

**可能考的其他脚本题型**：

| 题型 | 核心语法 |
|------|---------|
| 累加1到n | for + $(()) 算术运算 |
| 批量创建用户 | for + useradd + passwd --stdin |
| 检查文件是否存在 | if [ -f file ] |
| 倒计时 | while + sleep + echo |
| 判断成绩等级 | if-elif-else + read |

### 3.4 Shell脚本易错点

| 错误写法 | 正确写法 | 说明 |
|---------|---------|------|
| `sum = 0` | `sum=0` | 等号两边不能有空格 |
| `sum=$sum+$i` | `sum=$(($sum+$i))` | 算术运算要用$(()) |
| `[ $a == $b ]` | `[ "$a" == "$b" ]` | 变量最好加引号防空值 |
| `if[$a-gt$b]` | `if [ $a -gt $b ]` | 方括号两边要有空格 |
| `for i in 1-10` | `for i in $(seq 1 10)` | 范围要用seq或{} |
| `chmod 0+x` | `chmod o+x` | 是字母o不是数字0 |

---

## 第四部分：考前速记卡

### 4.1 高频填空题速记

| 题目 | 答案 |
|------|------|
| CPU由运算器和___组成 | 控制器 |
| Linux软件包分两种：___和二进制包 | 源码包 |
| 管道符是___ | \|（竖杠） |
| DNS端口是___ | 53 |
| 临时切换root身份用___ | su |
| 挂载fstab中所有文件系统用___ | mount -a |
| DHCP获取IP用___启用网卡 | ifup |
| vim全文替换用___ | :1,$s/old/new/g |
| GCC指定库文件路径用___ | -L |
| Shell变量引用用___ | ${变量名} |

### 4.2 高频选择题速记

| 题目 | 答案 |
|------|------|
| 哪个不属于Linux家族 | Solaris |
| 设定用户密码的命令 | passwd |
| 切换目录的命令 | cd |
| cd ~的含义 | 到用户home目录 |
| 删除用户同时删除home目录 | userdel -r |
| 软链接文件标识 | l（ls -l第一个字符） |
| 权限644的含义 | rw-r--r-- |
| ps显示所有用户进程的参数 | a |
| 终止用户所有进程的命令 | killall |
| 启动时设置优先级 | nice |
| 卸载文件系统 | umount |
| 显示inode使用 | df -i |
| 查看swap | free |
| 以太网接口命名 | eth2 |
| 显示主机名 | hostname |
| 列出活跃网络接口 | ifconfig |
| 测试IP连通性 | ping |
| 启动Apache | service httpd start |
| 日志文件位置 | /var/log |
| vim复制4行 | 4yy |
| SSH是什么协议 | 安全外壳协议 |
| GDB查看变量类型 | whatis |
| makefile目标后跟 | 源文件 |
| ENOENT含义 | 无此文件或目录 |
| O_WRONLY含义 | 只写方式打开 |
| write返回值 | 实际写入字节数 |
| SIGTERM用途 | 清理后终止 |
| 管道通信结束后 | close() |
| Emacs翻屏 | Ctrl+v |
| Emacs模式行%% | 只读未修改 |

### 4.3 常用端口号速记

| 服务 | 端口 |
|------|------|
| SSH | 22 |
| HTTP | 80 |
| HTTPS | 443 |
| DNS | 53 |
| FTP控制 | 21 |
| FTP数据 | 20 |
| Samba | 139/445 |

### 4.4 权限数字速记

| 数字 | 权限 | 场景 |
|------|------|------|
| 777 | rwxrwxrwx | 所有人全权限（危险） |
| 755 | rwxr-xr-x | 可执行文件/目录 |
| 644 | rw-r--r-- | 普通文件 |
| 600 | rw------- | 私密文件 |
| 700 | rwx------ | 私密目录 |

---

## 第五部分：模拟自测题

### 5.1 选择题（20题，每题1分）

**1.** 下列命令中，可以用来查看当前目录下所有文件（包括隐藏文件）的是？
- A) ls -l
- B) ls -a ✅
- C) ls -R
- D) ls -ld

**2.** 执行 `ls -l` 后，某文件显示为 `drwxr-xr-x`，该文件类型是？
- A) 普通文件
- B) 目录 ✅
- C) 软链接
- D) 块设备

**3.** 将文件file的权限设置为644，下列命令正确的是？
- A) chmod 644 file ✅
- B) chown 644 file
- C) chgrp 644 file
- D) umask 644

**4.** 以下哪个命令可以查看CPU使用率最高的进程？
- A) ps aux
- B) top ✅
- C) free
- D) df

**5.** 用`kill`命令终止进程时，`-9`信号表示？
- A) 优雅终止
- B) 强制终止 ✅
- C) 暂停进程
- D) 重启进程

**6.** 以下哪个不是Linux的特点？
- A) 多用户
- B) 多任务
- C) 单平台 ✅
- D) 开源

**7.** 在vim中，要删除当前行，应按？
- A) dd ✅
- B) yy
- C) p
- D) u

**8.** 在vim中，要将文件中所有的"old"替换为"new"，命令是？
- A) :s/old/new/
- B) :s/old/new/g
- C) :%s/old/new/g ✅
- D) :%s/old/new/

**9.** 使用scp将本地文件上传到远程服务器，命令格式是？
- A) scp remote:/file local
- B) scp local user@remote:/path ✅
- C) scp -r local remote
- D) scp local remote

**10.** Shell脚本中，`$1`代表？
- A) 脚本名称
- B) 第一个参数 ✅
- C) 参数个数
- D) 所有参数

**11.** 下列哪个是块设备？
- A) 串行口
- B) 硬盘 ✅
- C) 虚拟终端
- D) 打印机

**12.** `mount -a`命令的作用是？
- A) 卸载所有文件系统
- B) 挂载/etc/fstab中所有文件系统 ✅
- C) 列出所有挂载点
- D) 检查文件系统

**13.** `df -i`显示的是？
- A) 磁盘空间使用
- B) inode使用情况 ✅
- C) 文件系统类型
- D) 目录大小

**14.** 在Shell中，`2>&1`表示？
- A) 标准输出重定向到标准错误
- B) 标准错误重定向到标准输出 ✅
- C) 标准输入重定向到标准错误
- D) 标准输出重定向到标准输入

**15.** Linux第一块IDE磁盘的名称是？
- A) /dev/sda
- B) /dev/hda ✅
- C) /dev/sdb
- D) /dev/hdb

**16.** Emacs中模式行显示"**"表示？
- A) 只读未修改
- B) 缓冲区已修改 ✅
- C) 可写未修改
- D) 只读已修改

**17.** GCC中`-g`选项的作用是？
- A) 优化代码
- B) 产生调试信息 ✅
- C) 指定输出文件
- D) 显示警告

**18.** GDB中设置断点的命令是？
- A) run
- B) break ✅
- C) next
- D) continue

**19.** 系统调用open()中O_RDONLY表示？
- A) 只写
- B) 只读 ✅
- C) 读写
- D) 追加

**20.** SIGKILL信号的编号是？
- A) 1
- B) 2
- C) 9 ✅
- D) 15

### 5.2 填空题（10题，每题2分）

**1.** 冯诺依曼体系结构中，CPU由运算器和______组成。
> 控制器

**2.** Linux软件包分为源码包和______两种。
> 二进制包

**3.** 在Shell中，______是由竖杠（|）代表，用来连接多条命令。
> 管道符

**4.** DNS服务使用的端口是______。
> 53

**5.** 使用______命令可以将用户身份临时改变为root。
> su

**6.** 命令______用来装载所有在/etc/fstab中定义的文件系统。
> mount -a

**7.** vim中把全文的"abc"替换为"efg"，命令是______。
> :1,$s/abc/efg/g

**8.** GCC中______选项用来指定库文件的搜索路径。
> -L

**9.** Shell中已知nu=aaa，想使nu=aaabbb，应执行nu=______。
> ${nu}bbb

**10.** 系统调用write()成功时返回______。
> 实际写入的字节数

### 5.3 综合题（2题，每题20分）

**第1题**：请按顺序写出以下操作的命令：

| 步骤 | 操作 | 命令 |
|------|------|------|
| (1) | 在/tmp下创建目录test | `mkdir /tmp/test` |
| (2) | 进入该目录 | `cd /tmp/test` |
| (3) | 将/home/user/file.txt复制到当前目录 | `cp /home/user/file.txt .` |
| (4) | 将文件权限改为所有人可读写 | `chmod a+rw file.txt` |
| (5) | 用vim打开文件 | `vim file.txt` |
| (6) | 全文替换"old"为"new" | `:%s/old/new/g` |
| (7) | 删除第5行 | `dd`（光标在第5行时） |
| (8) | 保存退出 | `:wq` |
| (9) | 用scp上传到10.0.0.50的/tmp目录，用户user1 | `scp file.txt user1@10.0.0.50:/tmp/` |
| (10) | 用ssh以user1登录服务器 | `ssh user1@10.0.0.50` |
| (11) | 用gcc编译file.txt为mytest，带调试信息 | `gcc -g file.txt -o mytest` |
| (12) | 启动gdb调试mytest | `gdb mytest` |
| (13) | 在第3行设置断点 | `break 3` |

**第2题**：编写一个Shell脚本，功能如下：
- 生成一个1-100的随机数
- 让用户猜数字
- 如果猜大了提示"bigger"，猜小了提示"smaller"
- 猜对了提示"You are right"并退出

```bash
#!/bin/bash                          # (1) shebang声明
n1=$[ $RANDOM % 100 ]               # (2) 生成随机数
while :                              # (3) 无限循环
do
    read -p "Input a number: " n     # (4) 读取用户输入
    if [ $n -eq $n1 ]                # (5) 判断是否相等
    then
        echo "You are right"         # (6) 输出成功
        break                        # (7) 跳出循环
    elif [ $n -gt $n1 ]              # (8) 判断是否更大
    then
        echo "bigger"
    else
        echo "smaller"
    fi                               # (9) 结束if
done                                 # (10) 结束循环
```

---

## 附录：复习优先级建议

### 第一优先级（必背，占60%分值）
1. Shell脚本编程（综合题20分）
2. Linux基础命令ls/cd/chmod（选择题高频）
3. vim编辑器操作（选择题+综合题）
4. 用户管理useradd/userdel/passwd（选择题高频）
5. 进程管理ps/kill/nice（选择题高频）

### 第二优先级（重要，占25%分值）
6. 磁盘管理mount/df/fdisk（选择题高频）
7. 网络命令ifconfig/ping/hostname（选择题高频）
8. SSH/scp远程操作（选择题+综合题）
9. GCC/GDB编译调试（选择题+综合题）

### 第三优先级（了解，占15%分值）
10. 操作系统理论（填空题1-2题）
11. Emacs编辑器（选择题2题）
12. 系统调用/信号（选择题5题）
13. Make/Makefile（选择题1题）
14. 端口号/软件包分类（填空题）
