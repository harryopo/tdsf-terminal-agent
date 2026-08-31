---
source: apache-docs
category: services
url: consolidated/services/Web 服务器（Nginx 与 Apache）.md
title: Web 服务器（Nginx 与 Apache）
---

- 构建：./configure && make && make install；nginx -s reload|stop
- 日志/访问：--with-debug；error_log；allow/deny；auth_basic
- 反代/SSL：proxy_pass+upstream；rewrite；ssl_certificate(_key)；server_name
- 易错：无.htaccess；单位大小写；server_names_hash_max_size
- 协议：HTTP/2/3(QUIC)；WebSocket转发 Upgrade/Connection

- 编译须启用调试：`./configure --with-debug ...`
- 日志级别设为 `debug`：`error_log /path/to/log debug;`
- 验证：`nginx -V` 查看 `configure arguments` 是否含 `--with-debug`
- 预编译 Linux 包（1.9.8+）用 `nginx-debug` 二进制：先 `service nginx stop`，再 `service nginx-debug start`
- Windows 版默认支持调试，只需设 `debug` 级别

**易错点**：重新定义 `error_log` 时未带 `debug` 会禁用调试日志：
```nginx
error_log /path/to/log debug;
http {
    server {
        error_log /path/to/log;  # 此处禁用该 server 调试
    }
}
```
解决：注释掉该行，或同样加上 `debug`。

**仅对指定客户端调试**（在 `events` 块）：
```nginx
error_log /path/to/log;
events {
    debug_connection 192.168.1.1;
    debug_connection 192.168.10.0/24;
}
```

**循环内存缓冲**：`error_log memory:32m debug;` 高负载下性能影响小；可用 gdb/lldb 脚本从内存中提取日志。

## 访问控制

- 访问控制≠认证/授权；核心：`mod_authz_core`、`mod_authz_host`，另可用 `mod_rewrite`
- `Allow`/`Deny`/`Order`（`mod_access_compat`）已弃用，勿用

### 主机/IP 控制
- `Require host 域名` / `Require ip 地址`；IP 支持完整、部分、CIDR、IPv6：

```apache
Require ip 10.2.3.4
Require ip 172.20              # 匹配 172.20.0.0/16
Require ip 192.168.1.0/24
Require ip 2001:db8:1::/48
```

- `not` 取反不能单独用，须配 `RequireAll`/`RequireAny`/`RequireNone`：
```apache
<RequireAll>
  Require all granted
  Require not ip 10.252.46.165
</RequireAll>
```
域名同理：`Require not host phishers.example.com`

### 按任意变量控制
- `<If>` 或 `Require expr` 按请求头/环境变量控制：
```apache
Require expr %{HTTP_USER_AGENT} != 'BadBot'
```
- 易错：`User-Agent` 可伪造，不可靠

### mod_rewrite 控制
- `[F]` 标志返回 403：
```apache
RewriteEngine On
RewriteCond "%{TIME_HOUR}" ">=20" [OR]
RewriteCond "%{TIME_HOUR}" "<07"
RewriteRule "^/fridge" "-" [F]
```

### 易错点
- 2.4 起优先用 `<If>`，多数场景不必用 `mod_rewrite`
- `<Limit>` 在 `<Location>` 内会静默覆盖 `<Directory>` 限制

- `.htaccess` 按目录修改配置，无需改主配置；语法与主配置相同。
- 可改名：`AccessFileName ".config"`
- 生效由 `AllowOverride`/`AllowOverrideList` 决定；默认 `AllowOverride None` 忽略。
- 指令是否允许需看 Context；如 `AddDefaultCharset` 需要 `FileInfo`。
- 有主配置访问权时优先用主配置：主配置启动时加载，`.htaccess` 每请求逐级查找，性能差；`mod_rewrite` 在主配置中更好。
- 适用：无 root 权限的虚拟主机/CMS。
- 性能代价：启用后 httpd 逐级查找，如请求 `/www/htdocs/example/` 会检查多层路径，即使不存在也有额外开销。
- 安全：允许用户改配置可能失控，应明确权限级别。
- 细粒度：`AllowOverrideList` 只允许指定指令，未列出报错：
  ```
  AllowOverride None
  AllowOverrideList Redirect RedirectMatch RewriteEngine RewriteRule RewriteCond
  ```
- 等价于 `<Directory>` 段：
  ```
  # .htaccess
  AddType text/example ".exm"
  # httpd.conf
  <Directory "/www/htdocs/example">
      AddType text/example ".exm"
  </Directory>
  ```
- 完全禁用：`AllowOverride None`
- 作用于目录及子目录，子目录可覆盖上级；例：`Options +ExecCGI`

- `.htaccess` 使用 `Options` 需启用 `AllowOverride Options`；同目录 `.htaccess` 完全覆盖先前 `Options`（如仅 `Includes` 会禁用 CGI）。
- `.htaccess` 覆盖对应 `<Directory>`，但被主配置其他节（如 `<Location>`）覆盖。
- 认证需 `AllowOverride AuthConfig`：
```apache
AuthType Basic
AuthName "Password Required"
AuthUserFile "/www/passwords/password.file"
AuthGroupFile "/www/passwords/group.file"
Require group admins
```
- SSI 需启用 `AllowOverride Options` 与 `FileInfo`：
```apache
Options +Includes
AddType text/html "shtml"
AddHandler server-parsed shtml
```
- RewriteRule 相对于当前目录，URI 前导斜杠和目录前缀已去除：
```apache
# 根目录 .htaccess
RewriteRule "^images/(.+)\.jpg" "images/$1.png"
# images/ 目录 .htaccess
RewriteRule "^(.+)\.jpg" "$1.png"
```
- 正则表达式在 `.htaccess` 中每请求重编译；主配置只编译一次并缓存。
- CGI 需 `AllowOverride Options`：
```apache
Options +ExecCGI
AddHandler cgi-script "cgi" "py"
```
- 传统 CGI 不推荐，建议用 `mod_proxy_fcgi` 或框架处理器。

- `mod_proxy` 支持多协议代理/网关与负载均衡；需加载 `mod_proxy` + 协议模块（`mod_proxy_http`/`mod_proxy_fcgi`/`mod_proxy_ajp`），均衡加 `mod_proxy_balancer`。
- 正向代理：`ProxyRequests On`，客户端显式配置；**必须用 `<Proxy>` 限制来源**。
- 反向代理：`ProxyPass`/`ProxyPassReverse` 或 `RewriteRule ... [P]`；**不要开启 `ProxyRequests`**。

```apache
ProxyPass "/foo" "http://foo.example.com/bar"
ProxyPassReverse "/foo" "http://foo.example.com/bar"

ProxyRequests On
ProxyVia On
<Proxy "*">
  Require host internal.example.com
</Proxy>

ProxyPass "/ws/" "http://example.com/ws/" upgrade=websocket
```

- Handler 强制反向代理：PHP 转 FastCGI（2.4.10+；Unix socket 需 2.4.7+）：
```apache
<FilesMatch "\.php$">
  SetHandler "proxy:unix:/path/to/app.sock|fcgi://localhost"
</FilesMatch>
```

- Worker 管理后端连接；默认 worker 不启用 Keep-Alive，每请求新建 TCP；显式 worker 可设参数：
```apache
ProxyPass "/example" "http://backend.example.com" connectiontimeout=5 timeout=30
```

- 易错：正向代理未限源=开放代理；反向代理开 `ProxyRequests` 多余有害。

- worker 由源服务器 URL 定义；正向代理常用 `ProxySet`：
```apache
ProxySet "http://backend.example.com" connectiontimeout=5 timeout=30
```
- 直接 worker 自身不分正/反向；`ProxyPass` 创建的 worker 也可用于匹配的 forward 请求。
- URL 含路径时，路径不同即不同 worker、不同连接池：
```apache
ProxyPass "/examples" "http://backend.example.com/examples"
ProxyPass "/docs" "http://backend.example.com/docs"
```
- **Worker 共享**：后定义 worker 的 URL 是先前缀时不新建 worker，复用前者连接池，后者显式配置被忽略并 warning：
```apache
ProxyPass "/apps" "http://backend.example.com/" timeout=60
ProxyPass "/examples" "http://backend.example.com/examples" timeout=10
# /examples 实际 timeout=60
```
避免共享：URL 从长到短排序；最大化共享：从短到长排序。
- worker 分直接与 balancer；直接 worker 协议：`ajp`、`fcgi`、`ftp`、`http`、`scgi`；balancer 用 `balancer://`，成员用 `BalancerMember` 添加。
- 源域名 DNS：首次创建 socket 时解析；启用连接复用时，每个子进程仅解析一次并缓存至回收；规划 DNS 维护需注意。
- 访问控制：
```apache
<Proxy "*">
  Require ip 192.168.0
</Proxy>
```
`<Proxy "*">` 匹配所有请求（含 CONNECT 隧道）；CONNECT 隧道只能按客户端 IP 做访问控制。

- 依赖`mod_proxy`；支持 HTTP/FTP/AJP/WS；算法经 `lbmethod`（`mod_lbmethod_by*`）设置；自身无指令。
- 粘性：cookie/URL 编码，`stickysession` + `route`；开放代理极危险，启用前须访问控制。

配置示例（无粘性时省略 `route=` 与 `ProxySet`）：

```apache
<Proxy "balancer://mycluster">
    BalancerMember "http://192.168.1.50:80" route=1
    BalancerMember "http://192.168.1.51:80" route=2
    ProxySet stickysession=ROUTEID
</Proxy>
ProxyPass        "/test" "balancer://mycluster"
ProxyPassReverse "/test" "balancer://mycluster"
```

后端不设 cookie 时加：

```apache
Header add Set-Cookie "ROUTEID=.%{BALANCER_WORKER_ROUTE}e; path=/" env=BALANCER_ROUTE_CHANGED
```

环境变量：`BALANCER_SESSION_STICKY`、`BALANCER_SESSION_ROUTE`、`BALANCER_NAME`、`BALANCER_WORKER_NAME`、`BALANCER_WORKER_ROUTE`、`BALANCER_ROUTE_CHANGED`。

动态管理（需 `mod_status`）：

```apache
<Location "/balancer-manager">
    SetHandler balancer-manager
    Require host example.com
</Location>
```

可动态调权重/下线；仅 `<Location>` 外定义的 Balancer 可被 Manager 控制。

### 粘性会话实现
- **Cookie 方式**：`ProxyPass`/`ProxySet` 加 `stickysession=COOKIE`（区分大小写）。后端 cookie 值含 `route`，Apache 据此匹配 `BalancerMember`。
- **Tomcat 特殊**：cookie 值为 `sessionid.jvmRoute`，Apache 只取点后部分；在 `server.xml` 设 `jvmRoute` 对应 route；默认 cookie 名 `JSESSIONID`。
- **URL 编码方式**：`stickysession=PARAM`，参数值匹配 route；Java 分号路径（如 `/app;jsessionid=...`）需加 `scolonpathdelim=On`。
- **同时支持**：`stickysession=COOKIE|PARAM`，URL 参数优先。

```apache
ProxyPass "/test" "balancer://mycluster" stickysession=JSESSIONID|jsessionid scolonpathdelim=On
<Proxy "balancer://mycluster">
    BalancerMember "http://192.168.1.50:80" route=node1
    BalancerMember "http://192.168.1.51:80" route=node2
</Proxy>
```

- **排查**：查错误日志；`LogFormat` 增加 `%{COOKIE}C`（cookie 值）、`%{BALANCER_SESSION_STICKY}e`（路由键名）、`%{BALANCER_SESSION_ROUTE}e`（请求携带 route）、`%{BALANCER_WORKER_ROUTE}e`（实际 worker route）、`%{BALANCER_ROUTE_CHANGED}e`（=1 即粘性失败）。

- 核心模块：`mod_ssl`，接口对接 OpenSSL 库，提供基于 SSL/TLS 协议的强加密。
- 官方子文档：
  - 配置指南：`ssl_howto.html`
  - SSL 介绍：`ssl_intro.html`
  - 兼容性：`ssl_compat.html`
  - 常见问题：`ssl_faq.html`
  - 词汇表：`glossary.html`
  - 模块完整指令与变量参考：`mod_ssl.html`
- 易错点：先阅读配置指南与兼容性文档；环境变量与指令细节以 `mod_ssl` 参考为准。

## Apache 虚拟主机核心知识点

- **虚拟主机（Virtual Host）**：单台物理机上运行多个网站（如 `company1.example.com`、`company2.example.com`），对终端用户透明。
- **两种类型**：
  - **基于 IP（IP-based）**：每个网站独立 IP 地址；
  - **基于名称（name-based）**：同一 IP 上运行多个域名。Apache 1.1+ 原生支持两者。

### 关键配置指令

- `<VirtualHost>`：定义虚拟主机容器
- `ServerName`：主机名
- `ServerAlias`：别名（name-based 多域名匹配）
- `ServerPath`：基于路径的匹配

### 调试方法

用 `-S` 命令行开关转储 Apache 解析后的配置（IP 与服务器名），排查配置错误：

```bash
# Unix
apachectl -S

# Windows
httpd.exe -S
```

### 相关模块

- `mod_vhost_alias`：动态批量虚拟主机

### 参考文档分类

- 基于名称：`name-based.html`
- 基于 IP：`ip-based.html`
- 常见配置示例：`examples.html`
- 文件描述符限制（日志过多问题）：`fd-limits.html`
- 动态大规模虚拟主机：`mass.html`
- 主机匹配深入解析：`details.html`

### 易错点

- 配置错误常见于 IP 地址与 `ServerName` 不匹配，`-S` 输出需仔细核对；
- 大量虚拟主机时注意文件描述符限制（`Too many log files`）。

- 认证验证身份，授权控制资源访问。
- 模块三类，每组至少选一个：
  - 认证类型：`mod_auth_basic`、`mod_auth_digest`
  - 提供者：`mod_authn_file`、`mod_authn_dbm`、`mod_authnz_ldap` 等
  - 授权：`mod_authz_user`、`mod_authz_groupfile`、`mod_authz_host` 等
  - 核心 `mod_authn_core`/`mod_authz_core` 必须加载。
- 前置：`.htaccess` 需 `AllowOverride AuthConfig`；密码文件放 Web 根之外。
- 创建密码：`htpasswd -c /usr/local/apache/passwd/passwords rbowen`
- 目录保护示例：
```
AuthType Basic
AuthName "Restricted Files"
AuthBasicProvider file
AuthUserFile "/usr/local/apache/passwd/passwords"
Require user rbowen
```
- 关键参数：`AuthType`；`AuthName` Realm；`AuthUserFile` 绝对路径；`Require` 支持 `user`/`group`/`valid-user`。
- 易错：Basic 密码明文，需 `mod_ssl`；Digest 不比 Basic 安全；指令只能放 `<Directory>` 或 `.htaccess`。

- **Realm**：多个区域共享同一 `AuthName` 时客户端只需认证一次；hostname 变化则需重输。

- `AuthBasicProvider` 默认 `file`，可省略；用 dbm/dbd 时需显式指定。

- `AuthUserFile` 指定 `htpasswd` 生成的密码文件；用户量大改用 `AuthDBMUserFile`（`mod_authn_dbm`），用 `dbmmanage`/`htdbm` 管理。

- `Require`：授权，限制可访问用户/组。

- 组文件格式：
  ```
  GroupName: rbowen dpitts sungo rshersey
  ```

- 追加用户（**不要用 `-c`**）：
  ```
  htpasswd /usr/local/apache/passwd/passwords dpitts
  ```

- 组认证 `.htaccess` 示例：
  ```
  AuthType Basic
  AuthName "By Invitation Only"
  AuthBasicProvider file
  AuthUserFile "/usr/local/apache/passwd/passwords"
  AuthGroupFile "/usr/local/apache/passwd/groups"
  Require group GroupName
  ```

- 替代：`Require valid-user` 放行任一用户；也可用多个密码文件模拟分组，Apache 只查一个文件更快。

- **性能易错点**：Basic 认证每次请求都验证，速度随密码文件大小线性下降，单文件用户数有实际上限。

### 进程模型
- 一个 master 进程 + 多个 worker 进程
- master：读取/校验配置、维护 worker；worker：实际处理请求
- `worker_processes` 可设为 `auto` 自动匹配 CPU 核数

### 启动/停止/重载
```
nginx -s signal
```
- `stop` 快速停止；`quit` 优雅停止；`reload` 重载配置；`reopen` 重开日志
- 配置修改后须 reload 或重启才生效
- reload 流程：master 校验新配置语法并尝试应用 → 成功则启新 worker，旧 worker 处理完当前请求退出；失败则回滚，沿用旧配置
- 须以启动 nginx 的用户执行

### 信号与进程
```
kill -s QUIT <pid>
ps -ax | grep nginx
```
- master PID 默认写入 `/usr/local/nginx/logs/nginx.pid` 或 `/var/run`

### 配置文件结构
- 默认文件：`nginx.conf`，位于 `/usr/local/nginx/conf`、`/etc/nginx` 或 `/usr/local/etc/nginx`
- 简单指令：`名称 参数;`；块指令：`{}` 包围；内含其他指令的块称 context
- 层级：`events`/`http` 在 main；`server` 在 http；`location` 在 server
- `#` 后为注释

### 静态内容
```
server {
    location / {
        root /data/www;
    }
    location /images/ {
        root /data;
    }
}
```
- 匹配的请求 URI 追加到 `root` 路径，形成本地文件路径
- 多 location 匹配时选**最长前缀**；`/` 是最短前缀，作兜底

**静态服务器**
- `root` 指定根目录，URI → `root + URI`，文件不存在返回 404。
```nginx
server {
    listen 80;
    location /images/ {
        root /data;
    }
    location / {
        root /data/www;
    }
}
```
- 生效：`nginx -s reload`

**代理服务器**
- `listen 8080` 定义被代理 server；`proxy_pass http://localhost:8080;` 转发。
```nginx
server {
    listen 8080;
    root /data/up1;
    location / {}
}
server {
    location / {
        proxy_pass http://localhost:8080/;
    }
    location ~ \.(gif|jpg|png)$ {
        root /data/images;
    }
}
```
- gif/jpg/png 本地提供，其余转发到 `localhost:8080`。

**location 选择规则**
- 先找最长前缀，再按序查正则（`~` 开头）。
- 正则命中则选用，否则用最长前缀。
- `root` 在 `server` 级作为默认值。

- `./configure` 生成 `Makefile`；`--help` 查看全部参数。
- 路径/身份参数（默认以 `--prefix=/usr/local/nginx` 为基准）：
  - `--prefix=path`：根目录
  - `--conf-path=path`：nginx.conf 路径
  - `--error-log-path=path`：错误日志
  - `--pid-path=path`：PID 文件
  - `--user=name --group=name`：worker 用户/组（默认 nobody）
- 连接/IO：`--with-threads`（线程池）、`--with-file-aio`（异步文件 I/O）。
- 常用 HTTP 模块（默认不构建）：
  - `--with-http_ssl_module`：HTTPS（需 OpenSSL）
  - `--with-http_v2_module`：HTTP/2
  - `--with-http_v3_module`：HTTP/3（需支持 HTTP/3 的 OpenSSL）
  - `--with-http_realip_module`：按指定头修改客户端地址
  - 动态模块：`--with-http_xslt_module=dynamic`（`=dynamic` 表示动态安装）
- 易错点：
  - 路径、日志、PID、用户可用 `nginx.conf` 的 `error_log`、`pid`、`user`、`lock_file` 覆盖。
  - HTTP 模块默认不编译，需显式 `--with-*`；HTTPS/HTTP/3 依赖 OpenSSL。

### 默认不构建（用 `--with-*` 启用）

- `--with-http_random_index_module`：随机索引 `/` 请求。
- `--with-http_secure_link_module`：安全链接。
- `--with-http_degradation_module`：降级。
- `--with-http_slice_module`：切片，提升大响应缓存。
- `--with-http_stub_status_module`：基础状态信息。

### 默认构建（用 `--without-*` 禁用）

- `--without-http_charset_module`：字符集。
- `--without-http_gzip_module`：gzip（需 zlib）。
- `--without-http_ssi_module`：SSI。
- `--without-http_userid_module`：客户端 cookie。
- `--without-http_access_module`：地址访问控制。
- `--without-http_auth_basic_module`：Basic 认证。
- `--without-http_mirror_module`：镜像子请求。
- `--without-http_autoindex_module`：目录列表。
- `--without-http_geo_module`：IP 变量。
- `--without-http_map_module`：变量映射。
- `--without-http_split_clients_module`：A/B 测试。
- `--without-http_referer_module`：Referer 拦截。
- `--without-http_rewrite_module`：URI 重写/重定向。

**前置条件**：Visual C (VS8/10/17)、MSYS2、Perl、Git、PCRE/zlib/OpenSSL 源码。

**关键设置**：`PATH` 加 Perl/Git/MSYS bin；运行 `vcvarsall.bat`。

**构建**：
1. `git clone https://github.com/nginx/nginx.git`
2. 解压 PCRE/zlib/OpenSSL 到 `objs/lib`
3. 配置：
```bash
auto/configure \
    --with-cc=cl \
    --with-debug \
    --prefix= \
    --conf-path=conf/nginx.conf \
    --sbin-path=nginx.exe \
    --with-pcre=objs/lib/pcre2-10.39 \
    --with-zlib=objs/lib/zlib-1.3.1 \
    --with-openssl=objs/lib/openssl-3.0.14 \
    --with-openssl-opt=no-asm \
    --with-http_ssl_module
```
4. `nmake`

**易错点**：`PATH`/`vcvarsall` 缺失→`cl`/`perl` 找不到；OpenSSL 必须 `no-asm` 否则汇编失败；库路径指向解压目录。

## Apache 缓存类型
- **三态HTTP缓存**：`mod_cache` + `mod_cache_disk`，按RFC2616存储内容，遵守HTTP头控制可缓存性；适用代理/动态内容加速。
- **两态键值缓存**：socache API，缓存SSL会话、认证凭据等底层数据；后端支持shmcb、memcache等。
- **专用文件缓存**：`mod_file_cache`，启动预载文件，减少磁盘访问，适合高频访问文件。

## 三态缓存机制
- **Fresh**：未过期，直接服务，不访问源服务器。
- **Stale**：过期后发条件请求验证；304则重新标记Fresh，200则替换；刷新失败时可暂时服务陈旧内容并加`Warning`头。
- **Non Existent**：缓存满可随时删除；`htcacheclean`可一次性或守护运行，按大小/inode限制，优先删stale再删fresh。

## CacheQuickHandler 阶段
- **快速处理器**：请求解析后立即查缓存，命中直接返回，性能最好；但绕过认证，带`Authorization`头不缓存。
- **正常处理器**：所有请求阶段后介入，可过滤/个性化内容；未命中时注册过滤器记录响应，可缓存则存，否则忽略。

## 易错点与优化
- 多别名虚拟主机设`UseCanonicalName On`，缓存键用规范主机名，避免重复缓存条目，提高命中率。

## 相关指令与模块
```apache
CacheEnable
CacheDisable
CacheNegotiatedDocs
UseCanonicalName
CacheQuickHandler
```

```apache
mod_cache
mod_cache_disk
mod_file_cache
mod_socache_*
```

### 新鲜度生命周期
- 可缓存内容应通过 `Cache-Control` 的 `max-age`/`s-maxage` 或 `Expires` 头声明明确新鲜度。
- 客户端可用请求中的 `Cache-Control` 覆盖源服务器定义的新鲜度；请求与响应中**较低**的新鲜度生效。
- 缺少时使用默认新鲜度（1小时），可用 `CacheDefaultExpire` 覆盖。
- 响应无 `Expires` 但有 `Last-Modified` 时，`mod_cache` 可用 `CacheLastModifiedFactor` 启发式推断新鲜度。
- 本地内容或未定义 `Expires` 的远程内容可用 `mod_expires` 添加 `max-age` 和 `Expires`。
- 最大新鲜度由 `CacheMaxExpire` 控制。

### 条件请求
- 内容过期后，httpd 将请求转为条件请求：
  - 缓存有 `ETag` → 请求添加 `If-None-Match`
  - 缓存有 `Last-Modified` → 请求添加 `If-Modified-Since`
- 源服务器检查标记：
  - 未变化：返回 `304 Not Modified`，缓存继续用旧内容至新新鲜度到期；
  - 已变化：正常返回新内容并更新缓存。
- 优点：避免传输完整资源；静态文件仅需 `stat()` 等系统调用，条件响应成本低，未变化的本地内容从缓存提供更快。
- 源服务器不支持条件请求时，按普通请求响应，缓存保存新内容，退化为简单两态（新鲜或删除）。

### 可缓存条件（RFC 2616）
1. URL 已启用缓存：`CacheEnable`/`CacheDisable`。
2. 状态码非 200/203/300/301/410 时，必须带 `Expires` 或 `Cache-Control` 头。
3. 请求必须是 HTTP GET。
4. 响应含 `Authorization` 头时，`Cache-Control` 必须含 `s-maxage`、`must-revalidate` 或 `public`。

## nginx 命令行参数

- `-?` / `-h`：帮助
- `-c file`：指定配置文件
- `-e file`：指定错误日志文件（1.19.5+）；`stderr` 表示标准错误
- `-g directives`：设置全局配置指令，如：
  ```nginx
  nginx -g "pid /var/run/nginx.pid; worker_processes `sysctl -n hw.ncpu`;"
  ```
- `-l port`：在指定端口/UNIX socket 启用控制 REST API（1.29.8+，商业版）
- `-p prefix`：设置路径前缀，默认 `/usr/local/nginx`
- `-q`：配置测试时抑制非错误消息
- `-s signal`：向 master 进程发信号
  - `stop` 快速停止
  - `quit` 优雅停止
  - `reload` 重载配置，新配置启动新 worker，优雅关闭旧 worker
  - `reopen` 重新打开日志文件
- `-t`：测试配置语法并尝试打开引用文件；`-T` 同 `-t` 且将配置输出到 stdout
- `-v`：版本；`-V`：版本+编译器+configure 参数

注意：`-s reload` 是优雅重载，不是重启；`-t` 仅测试不加载配置。

- 源码发行，覆盖 Unix 类系统；Windows 见官方文档。
- 发行版包布局可能不同，以发行版文档为准。

### 快速开始

```bash
tar xzf httpd-NN.tar.gz
cd httpd-NN
./configure --prefix=PREFIX
make
make install
vi PREFIX/conf/httpd.conf
PREFIX/bin/apachectl -k start
```

- `PREFIX` 默认 `/usr/local/apache2`；`NN` 为版本号。

### 依赖

- **APR/APR-Util**：源码放 `srclib/apr` 与 `srclib/apr-util`（目录名不带版本号），配置加 `--with-included-apr`；或安装系统 `-dev` 包。
- **PCRE2**：必需，不随 httpd 提供。找不到 `pcre2-config` 时用 `--with-pcre` 指定；安装 `libpcre2-dev` 或 `pcre2-devel`。
- 编译需 ≥200 MB 临时空间，安装后约 50 MB。
- 推荐 GCC，`PATH` 需含 `make` 等工具；系统时钟须准确。
- Perl 5 可选：支持 `apxs`、`dbmmanage`；缺失不影响构建。

### 校验

- 下载后必须用 PGP 签名校验：https://httpd.apache.org/dev/verification.html

### 配置

- 开发版需先安装 `autoconf`/`libtool` 并运行 `buildconf`；正式版不需要。
- 默认模块编译为 DSO，可运行时加载/卸载。
- 静态编译：`--enable-module=static`
- 更多选项：`configure --help`

- 附加模块：`--enable-module`，module 去掉 `mod_` 前缀、下划线转连字符；禁用用 `--disable-module`。**configure 不校验模块是否存在**，错误名称会被静默忽略。
- 可传环境变量/选项指定编译器、库、头文件；详阅 `configure --help`。示例：
```bash
CC="pgcc" CFLAGS="-O2" \
./configure --prefix=/sw/pkg/apache \
  --enable-ldap=shared --enable-lua=shared
```
- configure 运行几分钟，检测特性并生成 Makefile。

- 编译：`make`
- 安装：`make install`，通常需 root；升级安装不覆盖已有配置/文档。

- 自定义配置：编辑 `PREFIX/conf/httpd.conf`；手册在 `PREFIX/docs/manual/` 或 https://httpd.apache.org/docs/2.4/。

- 启动/测试/停止：
```bash
PREFIX/bin/apachectl -k start
# 访问 http://localhost/，DocumentRoot 通常为 PREFIX/htdocs/
PREFIX/bin/apachectl -k stop
```

- 升级：
  - 先读发布公告与源目录 `CHANGES`。
  - **大版本**（如 2.4→2.6）：编译期/运行期配置差异大，需手动调整；模块 API 变化，全部模块需重编译。
  - **小版本**（如 2.4.66→2.4.67）：`make install` 不覆盖文档/日志/配置；configure 选项、运行配置、模块 API 保持兼容；多数情况下同一 configure 命令行与配置可直接复用。
  - 跨小版本升级前，在已安装的 `build` 目录找到 `config.nice`（保存当时 configure 参数）。

**尺寸与偏移量**
- 后缀：`k`/`K`=KB，`m`/`M`=MB；偏移量另可用 `g`/`G`=GB
- 无后缀为字节

**时间间隔**
- 后缀：`ms`毫秒、`s`秒（默认）、`m`分、`h`时、`d`天、`w`周、`M`月（30天）、`y`年（365天）
- 多单位从高到低组合，空格可选：`1h 30m`=`90m`=`5400s`
- 无后缀为秒；建议显式写后缀
- 某些时间间隔仅秒级精度

- HTTPS 配置：`listen 443 ssl;`，指定证书私钥。  
```nginx
server { listen 443 ssl; ssl_certificate www.example.com.crt; ssl_certificate_key www.example.com.key; }
```
- 优化：SSL 握手耗 CPU。`worker_processes auto;` 利用核心；用会话缓存避免重复握手。  
```nginx
worker_processes auto;
http { ssl_session_cache shared:SSL:10m; ssl_session_timeout 10m; server { listen 443 ssl; keepalive_timeout 70; } }
```
- 1MB 缓存约 4000 会话，默认超时 5 分钟，可用 `ssl_session_timeout` 调整。

- 证书链：浏览器不认证书多为中间证书缺失。拼接顺序：服务器证书在前。  
```bash
cat www.example.com.crt bundle.crt > www.example.com.chained.crt
```
```nginx
ssl_certificate www.example.com.chained.crt;
```
- 顺序错误启动失败，报 `key values mismatch`。验证：`openssl s_client -connect www.example.com:443`，检查 `Certificate chain`。

- 同一 server 块监听 HTTP/HTTPS：  
```nginx
server { listen 80; listen 443 ssl; ssl_certificate www.example.com.crt; ssl_certificate_key www.example.com.key; }
```

## SSL 监听演进
- 0.7.14 前仅 `ssl` 指令全局开启；后新增 `listen` 的 `ssl` 参数，弃用 `ssl` 指令（1.25.1 移除）。

## HTTPS 多站点证书问题
- 共享 IP + `server_name` 时，浏览器总收默认证书：SSL 握手先于 HTTP，nginx 不知请求域名。
- 最可靠：每个 HTTPS 站点独立 IP。
- 多名称/通配符证书可共享 IP：SubjectAltName 长度有限；`*.example.org` 仅匹配单层子域，不匹配根域/深层；证书/私钥放 http 级共享单份内存。

```nginx
ssl_certificate     common.crt;
ssl_certificate_key common.key;
server {
    listen          443 ssl;
    server_name     www.example.com;
}
```

- SNI（RFC 6066）：浏览器握手时传域名，nginx 选证书；易错：SNI 仅域名，IP 访问不可靠。
- 需 OpenSSL 支持（构建/运行均需）；`nginx -V` 应见 `TLS SNI support enabled`，否则启动警告。

- nginx 支持多种连接处理方式，自动选最高效者；可用 `use` 指令显式指定。
- `select`/`poll`：标准方法，用于缺乏高效方法的平台；可用 `--with-select_module`/`--without-select_module`、`--with-poll_module`/`--without-poll_module` 强制启用/禁用模块。
- `kqueue`：高效方法，用于 FreeBSD 4.1+、OpenBSD 2.9+、NetBSD 2.0、macOS。
- `epoll`：高效方法，用于 Linux 2.6+。
  - 1.11.3+ 支持 `EPOLLRDHUP`（Linux 2.6.17, glibc 2.8）与 `EPOLLEXCLUSIVE`（Linux 4.5, glibc 2.24）。
- `/dev/poll`：高效方法，用于 Solaris 7 11/99+、HP/UX 11.22+（eventport）、IRIX 6.5.15+、Tru64 UNIX 5.1A+。
- `eventport`：用于 Solaris 10+；因存在已知问题，建议改用 `/dev/poll`。

```nginx
use epoll;  # 显式指定事件模型
```

易错点：
- 勿在 Solaris 10+ 默认选 `eventport`，优先 `/dev/poll`。
- 老系统如 SuSE 8.2 有补丁为 2.4 内核提供 epoll，但官方要求 Linux 2.6+。

- pid 默认 `/usr/local/nginx/logs/nginx.pid`，可用 `pid` 指令修改。
- 信号（master）：
  - `TERM/INT` 快速关闭；`QUIT` 优雅关闭
  - `HUP` 重载配置，新 worker 服务新连接，旧 worker 处理完旧连接后退出
  - `USR1` 重新打开日志；`USR2` 升级可执行文件；`WINCH` 优雅关闭 worker

## 重载（HUP）
校验配置 → 应用新配置（日志、listen socket）；失败回滚，成功则启动新 worker，优雅关闭旧 worker。

## 日志轮转
重命名旧日志 → 发 `USR1` → master 重开日志，worker 同步重开并关闭旧文件，旧文件可压缩。

## 在线升级
1. 替换新二进制，发 `USR2`
2. pid 文件改名为 `.oldbin`，新旧 master/worker 并存
3. 向旧 master 发 `WINCH` 停旧 worker
4. 成功后向旧 master 发 `QUIT`，仅留新进程

## 回滚
- 向旧 master 发 `HUP` 拉新 worker；再向新 master 发 `QUIT`
- 新 master 异常则发 `TERM`（必要时 `KILL`）；其退出后旧 master 自动接管并恢复 pid 文件名

- 识别 nginx 进程角色：master 命令含 `master process`，PPID 为 1；worker 含 `worker process`，PPID 指向 master。
- 验证命令：
```bash
ps -o pid,ppid,user,command
```

### 核心原则
- 禁用 `if ($http_host = ...)` + `rewrite` 模拟 Apache（易错、低效）
- 独立 `server` + `return 301` 跳转；`try_files` 替代文件存在性判断
### 主机名重定向
```nginx
server {
    listen 80;
    server_name example.org;
    return 301 http://www.example.org$request_uri;
}
```
### Mongrel 转换
```nginx
location / {
    root /var/www/myapp.com/current/public;
    try_files /system/maintenance.html
              $uri  $uri/index.html $uri.html
              @mongrel;
}
location @mongrel {
    proxy_pass http://mongrel;
}
```
- `try_files` 按序检查，全失败转 `@mongrel`；`$uri/index.html` 对应 Apache 的 index.html。

## Nginx 核心指令

### main 上下文

- `user user [group];`：worker 运行用户/组，须 root 启动时指定。
- `worker_processes number|auto;`：worker 数，`auto` 按核数；`worker_cpu_affinity` 绑核。
- `worker_rlimit_nofile number;`：worker 最大打开文件数，需配合 `ulimit`。
- `error_log file [level];`：级别 `debug|info|notice|warn|error|crit|alert|emerg`，默认 `error`，支持 `stderr`、`syslog:`。
- `pid file;`：master PID 文件路径。
- `include file|mask;`：包含配置，支持通配符，可用于任何上下文。
- `load_module file;`：动态加载模块（需 `--with-compat`）。
- `pcre_jit on|off;`：启用 PCRE JIT 加速正则。

### events 上下文

```nginx
events {
    worker_connections 2048;   # 每 worker 最大连接数
    use epoll;                 # 事件模型，auto 自动选择
    multi_accept on;           # 一次 accept 多个连接
    accept_mutex off;          # ≥1.11.3 默认 off
    debug_connection 127.0.0.1; # 需 --with-debug
}
```

- 总连接数 ≈ `worker_processes × worker_connections`。
- `accept_mutex`：低并发下避免惊群；支持 `EPOLLEXCLUSIVE`/`reuseport` 时无需开启。

## nginx 核心配置指令

- **include**：引入其他配置文件或匹配 mask 的文件。  
  ```nginx
  include mime.types;
  include vhosts/*.conf;
  ```
- **load_module**：加载动态模块，上下文 `main`，1.9.11+。  
  ```nginx
  load_module modules/ngx_mail_module.so;
  ```
- **lock_file**：指定锁文件前缀，默认 `logs/nginx.lock`；多数系统用原子操作，此指令被忽略。
- **master_process**：是否启动 worker 进程，默认 `on`，仅 nginx 开发者使用。
- **multi_accept**：控制 worker 一次接受所有新连接，默认 `off`；使用 `kqueue` 处理方法时忽略。
- **pcre_jit**：启用正则 PCRE JIT 加速，默认 `off`；需 PCRE≥8.20 且编译时 `--enable-jit`，nginx 需 `--with-pcre-jit`。
- **pid**：主进程 PID 文件，默认 `logs/nginx.pid`。
- **ssl_engine**：指定硬件 SSL 加速器名称。
- **ssl_object_cache_inheritable**：重载时继承 SSL 对象（证书/私钥/CA/CRL），默认 `on`。继承条件：
  - 文件未修改（mtime + inode 不变）可继承；
  - `engine:name:id` 私钥永不继承；
  - `data:value` 私钥总是继承；
  - 变量加载的 SSL 对象不可继承。
- **stall_threshold**：事件循环迭代超过阈值（默认 `1000ms`）报告 stall；启用 `timer_resolution` 时忽略阈值；属商业订阅功能。

- 请求跟踪（挂接 `ngx_http_process_request()`）：
```
pid$target::*ngx_http_process_request:entry
{
    this->request = (ngx_http_request_t *)copyin(arg0, sizeof(ngx_http_request_t));
    this->request_line = stringof(copyin((uintptr_t)this->request->request_line.data,
                                         this->request->request_line.len));
    printf("request line = %s\n", this->request_line);
    printf("request start sec = %d\n", this->request->start_sec);
}
```
- 易错：需结构体定义；`#include`+`-C`因头文件依赖失败。解法：手动精简（含 `objs/ngx_auto_config.h`、基础类型、`ngx_http_headers_in_t`/`out_t`），无关指针 typedef void：
```
typedef ngx_http_upstream_t     void;
typedef ngx_http_request_body_t void;
```
- 运行：
```
dtrace -C -I ./objs -s trace_process_request.d -p 4848
```

- **功能**：Apache 配置指令快速参考，列出每条指令的用法、默认值、状态与可用上下文。
- **表格列**：①指令名及用法；②默认值（过长截断，后加 `+`）；③允许的上下文；④指令状态。
- **上下文图例**：`s`=server config，`v`=virtual host，`d`=directory，`h`=.htaccess，`p`=proxy section。
- **状态图例**：`C`=Core，`M`=MPM，`B`=Base，`E`=Extension，`X`=Experimental，`T`=External。
- 详细说明见 Directive Dictionary（directive-dict.html）。

## Apache 指令索引表核心要点

- 索引表按字母序：指令名称、默认值、生效上下文、所属模块。
- 上下文标记（可组合）：`s`=服务器全局；`v`=虚拟主机；`d`=目录容器；`h`=`.htaccess`。
- 模块类型：`C`=核心、`B`=基础、`D`=认证/授权、`E`=扩展、`M`=MPM。

### 关键默认值
- `AccessFileName .htaccess`
- `AllowOverride None`：默认禁用 `.htaccess` 指令覆盖
- `AddDefaultCharset Off`
- `AllowCONNECT 443 563`

### 常用指令速记
- `Alias [URL-path] file-path|directory-path`：URL → 文件系统路径
- `AliasMatch regex file-path|directory-path`：正则映射 URL
- `AddType media-type extension [extension]...`：扩展名绑定 MIME
- `AddHandler handler-name extension [extension]...`：扩展名绑定处理器
- `AddCharset charset extension...`：扩展名绑定字符集
- `AddOutputFilterByType filter media-type...`：按 MIME 分配过滤器
- `AllowEncodedSlashes On|Off|NoDecode`：控制 URL 编码斜杠

### 易错点
- 指令须在允许上下文使用；如 `AllowOverride` 仅限目录上下文（`d`），全局配置或虚拟主机中无效。
- `.htaccess` 受对应目录 `AllowOverride` 限制，未允许的指令类型被静默忽略。
- `AllowCONNECT` 默认仅 443/563 端口，代理需其他端口须显式添加。

### mod_auth_digest
- `AuthDigestNonceLifetime seconds`：nonce 有效期，默认300秒（d,h）
- `AuthDigestProvider provider-name ...`：认证提供者，默认file，可多个（d,h）
- `AuthDigestQop none|auth|auth-int`：保护级别，默认auth（d,h）
- `AuthDigestShmemSize size`：跟踪客户端的共享内存，默认1000（仅s）

### mod_auth_form
- `AuthFormAuthoritative On|Off`：是否仅由本模块认证，默认On（d,h）
- `AuthFormBody fieldname`：请求体字段名，默认httpd_body（d）
- `AuthFormDisableNoStore On|Off`：禁用登录页no-store头，默认Off（d）
- `AuthFormFakeBasicAuth On|Off`：伪造Basic认证头，默认Off（d）
- `AuthFormLocation fieldname`：成功登录后重定向URL字段名，默认httpd_location（d）
- `AuthFormLoginRequiredLocation url`：需登录时重定向URL（d）
- `AuthFormLoginSuccessLocation url`：成功登录后重定向URL（d）

上下文：d=directory，h=.htaccess，s=server config。

- **DSO**：动态共享对象，模块编译为 `.so`，独立于 httpd；可用 apxs 事后编译。
- **mod_so**：必须静态编译，唯一不能作为 DSO 的模块。
- **LoadModule**：在 httpd.conf 中加载模块。

**构建**（编译后须加 LoadModule）：
```bash
./configure --prefix=/path/to/install --enable-foo
make install
```
```bash
./configure --enable-mods-shared=all
make install
```
```bash
./configure --enable-mods-shared=reallyall --enable-load-all-modules
make install
```
- `all` 不含开发模块，`reallyall` 包含。
- 第三方模块用 `apxs -cia mod_foo.c`。

**机制**：
- 共享库：`ld.so` 自动加载（`-lfoo`，`LD_LIBRARY_PATH`）。
- DSO：运行时 `dlopen()` 加载，`dlsym()` 解析，按需省内存。

**易错**：
- `mod_so` 不可作 DSO。
- 忘加 `LoadModule` 不生效。
- 用 `reallyall` 才含开发模块。

## DSO 核心知识点

### 关键概念
- DSO（动态共享对象）用于扩展程序时，难点是**反向解析**可执行程序符号：库通常不感知宿主程序，该机制未标准化、非全平台可用。
- 可执行程序的全局符号常不被重新导出，需强制链接器导出全部全局符号，这是运行时扩展的主要问题。
- 共享库方式（为 DSO 设计）是典型的库实现方式。

### 优点
- **运行时灵活性**：通过 `httpd.conf` 的 `LoadModule` 指令组装服务器，而非编译期 `configure`；可基于同一安装运行多实例（SSL/标准、精简/动态模块版）。
- **安装后扩展**：第三方模块可随时追加；便于厂商拆分为核心包 + 扩展包（PHP、mod_perl、mod_security 等）。
- **模块原型开发便捷**：在 Apache 源码树外开发，配合 `apxs` 只需：
  ```bash
  apxs -i
  apachectl restart
  ```

### 缺点
- **启动慢约 20%**：Unix 加载器符号解析开销。
- **执行慢约 5%**（部分平台）：PIC 需复杂汇编相对寻址。
- **链接受限**：非所有平台支持 DSO 模块链接其他 DSO 库（a.out 平台不支持，ELF 支持）。DSO 模块仅能用以下符号：
  - httpd 核心
  - C 库（`libc`）及核心使用的其他动态/静态库
  - 含 PIC 的静态库（`libfoo.a`）
- 需用其他代码时，只能让核心预先引用该代码，或用 `dlopen()` 自行加载。

## mod_rewrite 核心知识点

- **作用**：用正则规则改写入站 URL，映射到内部结构。
- **文档章节**：
  - intro：正则、`RewriteRule`/`RewriteCond` 基础、请求处理周期。
  - htaccess：服务器配置 vs 每目录（`.htaccess`）；路径剥离、`RewriteBase`、`[L]` 循环。
  - flags：全部标志参考。
  - rewritemap：外部映射（文本、DBM、SQL、函数）。
  - remapping：常见配方——HTTPS、主机名规范化、尾斜杠、前端控制器。
  - vhosts：动态虚拟主机映射主机名到 docroot。
  - avoid：可用更简指令替代的场景。
  - tech：请求处理阶段与求值顺序。

## 核心指令/参数

```apache
RewriteRule   # 定义规则
RewriteCond   # 条件
RewriteBase   # 每目录基准 URL
RewriteMap    # 外部映射
[L]           # 停止；每目录下会循环
```

## 参考

- 官方：`mod_rewrite.html`
- 映射：`urlmapping.html`
- Wiki：`cwiki.apache.org/confluence/display/httpd/Rewrite`

- 虚拟主机选择：按 `Host` 头匹配 `server`；无匹配时用该端口默认 server（默认第一个，可用 `listen ... default_server` 指定）。
- **易错**：默认 server 是 listen 端口的属性，不是 server_name 的属性。
- 阻止无 Host 请求：`server_name ""; return 444;`（0.8.48+ 空 server_name 为默认，可省略）。
- 混合 IP 与名称：先按 IP:port 匹配 `listen`，再按 Host 匹配 `server_name`；未命中则用默认 server。
- location 选择：
  - 前缀 location：选最长匹配，与配置顺序无关。
  - 正则 location（`~` / `~*`）：按配置顺序，第一个命中即用。
  - 正则无匹配时，回退到最长前缀 location。
  - location 只匹配 URI，不含查询参数。
- 典型 PHP 配置（要点）：
  - `/logo.gif`：前缀 `/` 匹配，正则 `\.(gif|jpg|png)$` 命中，由该正则处理。
  - `/index.php`：前缀 `/` 匹配，正则 `\.php$` 命中，转 FastCGI；`SCRIPT_FILENAME=$document_root$fastcgi_script_name`。
  - `/about.html`：仅前缀 `/` 匹配，映射到 `$root/about.html`。
  - `/`：`index` 指令在 `index.html` 不存在时内部重定向到 `/index.php`，重新执行 location 匹配。
- **易错**：
  - 正则 location 有顺序性；前缀 location 无顺序性（取最长）。
  - 内部重定向会重新走一遍 location 匹配流程。
  - 查询字符串永远不参与 location 匹配。

- TCP/UDP 会话按**阶段**依次处理：
  - **Post-accept**：接受连接后首阶段，调用 `ngx_stream_realip_module`。
  - **Pre-access**：初步访问检查，调用 `ngx_stream_limit_conn_module`、`ngx_stream_set_module`。
  - **Access**：实际数据处理前的访问限制，调用 `ngx_stream_access_module`；njs 对应 `js_access` 指令。
  - **SSL**：TLS/SSL 终止，调用 `ngx_stream_ssl_module`。
  - **Preread**：将初始字节读入 `preread_buffer_size` 缓冲区，供 `ngx_stream_ssl_preread_module` 等预分析；njs 对应 `js_preread`。
  - **Content**：强制阶段，实际处理数据，通常代理到 upstream（`ngx_stream_proxy_module`），或用 `ngx_stream_return_module` 返回值；njs 对应 `js_filter`。
  - **Log**：记录会话处理结果，调用 `ngx_stream_log_module`。

- 易错点：
  - `Pre-access` 与 `Access` 都是访问控制，但前者为前置检查，后者为实际限制。
  - `SSL` 阶段在 `Preread` 之前，若需按 SNI 分流，须用 `ssl_preread` 而非 `ssl` 终止。
  - `Content` 是唯一必经处理阶段。

### HTTP/2 核心概念
- 二进制协议（HTTP/1.1 为纯文本），语义不变
- **h2**：基于 TLS（ALPN 协商）；**h2c**：明文 TCP（已从规范移除，httpd 仍支持）
- **frame**：最小通信单元；**stream**：连接内双向帧流
- 单 TCP 连接多路复用多 stream，解决 HTTP/1.1 队头阻塞
- Server Push 已废弃，用 Early Hints 替代

### 构建
- 依赖 nghttp2 库，需 libnghttp2 ≥ 1.2.1
- configure 参数：`--enable-http2`；自定义路径 `--with-nghttp2=<path>`；静态链接 `--enable-nghttp2-staticlib-deps`
- TLS 需 ALPN 支持，OpenSSL ≥ 1.0.2

### 基础配置
```apache
LoadModule http2_module modules/mod_http2.so
Protocols h2 http/1.1        # 仅启用 h2
Protocols h2 h2c http/1.1    # 启用全部变体
```
- 可在 VirtualHost 内嵌套覆盖全局配置
- **协议顺序即优先级**，左侧最优先，推荐 `h2 h2c http/1.1`（若写 `http/1.1 h2`，则除非客户端仅支持 h2，否则永远选 HTTP/1）
- `ProtocolsHonorOrder Off`：忽略服务端顺序，由客户端偏好决定
- Protocols 不做拼写校验，无需 `<IfModule>` 包裹

### 易错点
- SSLCipherSuite 必须配置强密码套件；弱密码会让浏览器拒绝 h2 回退 HTTP/1.1，需避开 [RFC 9113](https://www.rfc-editor.org/rfc/rfc9113#section-9.2.2) TLS 拒绝列表
- prefork MPM 对 HTTP/2 有严重限制

- `prefork` 下 `mod_http2` 每个连接一次仅处理一个请求；慢请求或长轮询会阻塞其余请求。默认不绕过此限制，因 `prefork` 仅用于不支持多线程的处理引擎。若平台支持，推荐改用 `event` MPM。若坚持 `prefork` 且需并发，可调 `H2MinWorkers`，但后果自负。

- 客户端：现代浏览器（约 2015 年起）均支持 TLS 上的 HTTP/2；非浏览器客户端支持明文 h2c，最通用的是 `curl`。

- 调试工具：
  - `curl`：确认支持 HTTP/2（Features 含 `HTTP2`）：
```bash
$ curl -V
curl 8.20.0 (x86_64-pc-linux-gnu) libcurl/8.20.0 OpenSSL/3.5.7 zlib/1.3.1 nghttp2/1.69.0
Features: ... HTTP2
```
  - macOS Homebrew：`brew install curl` 默认含 HTTP/2，并按提示调整 PATH。
  - `wireshark`：深度帧分析。
  - `nghttp2` 包含：`nghttp`（可视化 HTTP/2 帧）、`h2load`（压力测试）。
  - Chrome：`chrome://net-internals/#http2`；浏览器扩展可显示是否使用 HTTP/2。

- Server Push：已被 RFC 9113 弃用；Chrome/Edge 106+ 已移除支持。`mod_http2` 仍实现，但新部署应使用 103 Early Hints 替代。

## 安装 nginx

- 安装方式取决于操作系统
- **Linux**：使用 [nginx.org 官方包](https://nginx.org/en/linux_packages.html)
- **FreeBSD**：
  - packages：预编译二进制，安装快
  - ports：更灵活，可编译指定选项后安装
- **源码编译**：包/ports 无法满足特殊功能时使用；灵活但新手上手复杂

- `error_log` / `access_log` 支持 `syslog:` 前缀。
- 参数：
  - `server=address`：域名/IP 加可选端口，或 `unix:` 前缀的 UNIX 套接字路径；缺省端口 UDP 514；域名多 IP 时取第一个。
  - `facility=string`：RFC 3164 facility，默认 `local7`；如 `kern`、`user`、`local0`~`local7`。
  - `severity=string`：仅作用于 `access_log`，默认 `info`；`error_log` 中忽略（错误级别由 nginx 决定）。
  - `tag=string`：默认 `nginx`。
  - `nohostname`：禁用 syslog 消息头中的 hostname 字段（1.9.7+）。

```nginx
error_log syslog:server=192.168.1.1 debug;
access_log syslog:server=unix:/var/log/nginx.sock,nohostname;
access_log syslog:server=[2001:db8::1]:12345,facility=local7,tag=nginx,severity=info combined;
```

- 支持 syslog 自 1.7.1 起；商业订阅版自 1.5.3 起。

# Apache 2.4 模块索引核心

- 模块索引列出 Apache 发行版自带模块，可配合指令参考使用。
- 模块分两类：核心与 MPM、其他模块。

## 核心与 MPM
- `core`：始终可用的核心特性。
- `prefork`：非线程、预派生子进程模型。
- `worker`：混合多进程多线程模型。
- `event`：`worker` 变体，仅活动连接占用线程。
- `mpm_winnt`：面向 Windows NT 优化的模型。
- `mpm_common`：多个 MPM 共享的指令集。

## 其他模块关键分类
- **认证与授权**
  - 认证：`mod_auth_basic`、`mod_auth_digest`、`mod_auth_form`；后端支持 `mod_authn_file`、`mod_authn_dbd`（SQL）、`mod_authnz_ldap`。
  - 授权：`mod_authz_core`、`mod_authz_host`、`mod_authz_user`。
- **映射与目录**：`mod_alias`、`mod_dir`、`mod_autoindex`。
- **动态内容/脚本**：`mod_cgi`、`mod_cgid`、`mod_actions`、`mod_include`、`mod_isapi`。
- **缓存与压缩**：`mod_cache`（+`mod_cache_disk`/`mod_cache_socache`）、`mod_file_cache`、`mod_deflate`、`mod_brotli`、`mod_filter`。
- **HTTP 协议与头**：`mod_http2`、`mod_headers`、`mod_expires`。
- **负载均衡**：`mod_lbmethod_byrequests`、`mod_lbmethod_bybusyness`。
- **其他常用**：`mod_dav`、`mod_dbd`、`mod_info`、`mod_env`、`mod_imagemap`。

### 负载均衡
- `mod_proxy_balancer`：负载均衡
- `mod_lbmethod_bytraffic`：加权流量调度
- `mod_lbmethod_heartbeat`：心跳流量调度
- `mod_proxy_hcheck`：动态健康检查

### 代理（mod_proxy 系列）
- `mod_proxy`：多协议代理/网关
- `mod_proxy_http`/`http2`/`fcgi`/`ajp`/`scgi`/`uwsgi`/`ftp`/`wstunnel`：协议代理
- `mod_proxy_connect`：CONNECT
- `mod_proxy_html`：HTML 链接重写

### 日志
- `mod_log_config`：请求日志
- `mod_log_debug`：调试日志
- `mod_log_forensic`：取证日志
- `mod_logio`：收发字节数

### MIME 与内容
- `mod_mime`：扩展名关联
- `mod_mime_magic`：内容字节判 MIME
- `mod_negotiation`：内容协商

### 会话
- `mod_session`：会话支持
- `mod_session_cookie`：Cookie 会话

### 其他
- `mod_ldap`：LDAP 连接池/缓存
- `mod_lua`：Lua 钩子
- `mod_md`：ACME 证书签发
- `mod_ratelimit`：客户端限速
- `mod_remoteip`：代理头替换 IP
- `mod_reqtimeout`：超时/最小数据率
- `mod_rewrite`：URL 重写

#### 模块 ngx_http_access_module

- 功能：基于客户端 IP 地址限制访问。
- 规则按顺序匹配，**首个匹配生效**；规则过多时建议用 `ngx_http_geo_module`。

示例配置：

```nginx
location / {
    deny  192.168.1.1;
    allow 192.168.1.0/24;
    allow 10.1.1.0/16;
    allow 2001:0db8::/32;
    deny  all;
}
```

此例允许 `10.1.1.0/16`、`192.168.1.0/24`（排除 `.1.1`）及 `2001:0db8::/32`。

**指令**

- `allow address | CIDR | unix: | all;`  
  上下文：`http`, `server`, `location`, `limit_except`  
  允许指定地址/网段；`unix:`（1.5.1）允许所有 UNIX 域套接字。

- `deny address | CIDR | unix: | all;`  
  上下文同上，拒绝访问。

**易错点**

- 同级可多条 `allow`/`deny`。
- **继承规则**：仅当当前级未定义任何 `allow` 和 `deny` 时，才继承上一级；否则全部重新定义。
- `satisfy` 指令决定地址限制与其他方式（密码、JWT 等）的组合逻辑。

`ngx_http_addition_module`：响应前后插入文本的过滤器，默认不编译，需 `--with-http_addition_module`。

```nginx
location / {
    add_before_body /before_action;
    add_after_body  /after_action;
}
```

- **add_before_body uri** | 上下文：http/server/location
  子请求返回文本加在响应体前；`""` 取消上级继承。
- **add_after_body uri** | 上下文：http/server/location
  子请求返回文本加在响应体后；`""` 取消上级继承。
- **addition_types mime-type ...** | 默认 `text/html` | 上下文：http/server/location
  限制可添加文本的 MIME 类型；`*` 匹配任意类型（0.8.29+）。

**模块功能**
- 通过 REST API 查询状态、动态配置 upstream 服务器组、管理 key-value 对，无需重载配置。
- 取代 `ngx_http_status_module` 与 `ngx_http_upstream_conf_module`。

**指令**
- `api [write=on|off];` — 上下文 `location`。启用 API；`write=on` 为读写，默认只读。所有请求 URI 需含 API 版本（当前 `9`）；若 URI 等于 location 前缀则返回支持版本列表。可用 `?fields=` 过滤对象字段。
- `status_zone zone;` — 上下文 `server`、`location`、`if in location`。收集状态到指定 zone，多 server 可共享；`off` 禁用嵌套 location 统计。统计在请求处理结束的 location 上下文，内部重定向时可能不同。

**配置要点**
- 被管理的 upstream 需配置 `zone`（如 `zone http_backend 64k;`）。
- API location 需限制访问：
```nginx
location /api {
    api write=on;
    allow 127.0.0.1;
    deny all;
}
```

**API 端点示例**
- `/api/9/nginx`、`/api/9/connections`、`/api/9/workers`
- `/api/9/http/requests`、`/api/9/http/server_zones/...`
- `/api/9/http/upstreams/{name}/servers/`
- `/api/9/http/keyvals/{zone}?key=...`
- `/api/9/stream/...`

**易错点**
- `PATCH`/`POST` 请求体超过 `client_body_buffer_size` 会返回 `413`。
- 该模块为商业订阅功能。

## API 版本与新增功能

- **v2**：HTTP upstream 新增 `drain`；新增 `/stream/keyvals/`。
- **v3**：新增 `/stream/zone_sync/`。
- **v4**：error 对象移除 `path`/`method`。
- **v5**：`expire` 可设置/修改；新增 `/resolvers/`、`/http/location_zones/`。
- **v6**：新增 `/stream/limit_conns/`、`/http/limit_conns/`、`/http/limit_reqs/`。
- **v7**：`responses` 新增 `codes`。
- **v8**：SSL 统计新增失败计数器；upstream/server zone 新增 `ssl`。
- **v9**：新增 `/license`、`uuid`、`response_time_hist`、`/workers/`。

## 端点

- **`/`**
  - `GET`：根端点列表。
  - 响应：`200`、`404`。

- **`/nginx`**
  - `GET`：版本、构建名、地址、重载次数、进程 ID。
  - 参数：`fields`。
  - 响应：`200`、`404`。

- **`/processes`**
  - `GET`：异常终止/重生子进程数。
  - `DELETE`：重置计数器。
  - 响应：`204`、`404`、`405`。

- **`/connections`**
  - `GET`：客户端连接统计。
  - `DELETE`：重置已接受/丢弃统计。
  - 参数：`fields`。
  - 响应：`204`、`404`、`405`。

- **`/slabs/`**
  - `GET`：slab 共享内存区状态。
  - 参数：`fields`；**为空时仅输出 zone 名称**。
  - 响应：`200`、`404`。

**易错点**：`fields` 控制输出字段；`/slabs/` 空值行为特殊；v4 起 error 对象不再返回 `path`/`method`。

## ngx_http_auth_basic_module

基于 HTTP Basic Authentication 协议校验用户名/密码，限制资源访问。也可按地址、子请求结果、JWT 限制；多条件同时限制由 `satisfy` 指令控制。

### 指令
- `auth_basic string | off;` 默认 `off`；上下文 `http, server, location, limit_except`。参数作 realm，支持变量（1.3.10/1.2.7）；`off` 取消上层继承。
- `auth_basic_user_file file;` 无默认；上下文同上；文件名支持变量。格式：
```
# comment
name1:password1
name2:password2:comment
```

### 密码类型
- `crypt()` 加密：Apache `htpasswd` 或 `openssl passwd` 生成
- Apache 变体 MD5（apr1）：同上工具生成
- RFC 2307 `{scheme}data` 语法：`PLAIN`（勿用）、`SHA`（勿用）、`SSHA`（OpenLDAP/Dovecot 使用）

### 示例
```
location / {
    auth_basic           "closed site";
    auth_basic_user_file conf/htpasswd;
}
```

### 易错点
- `SHA` 仅用于从其他 Web 服务器迁移；无盐 SHA-1 易受彩虹表攻击，勿用于新密码
- `PLAIN` 仅为示例，不应使用

- `ngx_http_auth_jwt_module`（1.11.3+）：校验 JWT 授权，支持 JWS/JWE（1.19.7+）/嵌套 JWT（1.21.0+），用于 OpenID Connect；商业模块，可配 `satisfy`。
- 算法：JWS 支持 HS/RS/ES/PS/EdDSA；JWE 支持 AES-CBC/GCM 加密及 AES/RSA 密钥管理（旧版仅 HS/RS/ES）。
- 常用配置：`location / { auth_jwt "closed site"; auth_jwt_key_file conf/keys.json; }`
- `auth_jwt string [token=$variable] | off`：启用，默认读 Authorization Bearer；可用 `token=$cookie_auth_token` 换源。
- `auth_jwt_key_file file`：JWKS 文件，可多条，任一失败即 500。
- `auth_jwt_key_request uri`：子请求取 JWKS，可含变量，建议配 `proxy_cache`。
- `auth_jwt_key_cache time`：密钥缓存，默认 0；变量来源不支持。
- `auth_jwt_claim_set $var name...` / `auth_jwt_header_set $var name...`：提取 claim/头，支持多级键名（如 `info e-mail`）；1.13.7 前仅单键名。
- `auth_jwt_leeway time`：exp/nbf 容差，默认 0s。
- `auth_jwt_type signed|encrypted|nested`：默认 signed。
- `auth_jwt_require $value... [error=401|403]`：附加条件校验。

- `auth_jwt_require`：附加 JWT 校验。值可含文本/变量/组合，但必须以变量开头（1.21.7）。认证通过条件：所有值非空且不等于 `"0"`。  
  失败返回 `401`；可选 `error` 参数改为 `403`。

```nginx
map $jwt_claim_iss $valid_jwt_iss {
    "good" 1;
}
...
auth_jwt_require $valid_jwt_iss;
```

- 嵌入变量：
  - `$jwt_header_<name>`：JOSE 头
  - `$jwt_claim_<name>`：JWT 声明
  - 嵌套或含点（`.`）的 claim 无法求值，改用 `auth_jwt_claim_set`
  - JWE 令牌的变量值在 Access 阶段解密后才可用
  - `$jwt_payload`（1.21.2）：嵌套令牌返回 JWS；加密令牌返回 JSON claims

## ngx_http_auth_request_module

基于子请求结果实现客户端授权（自1.5.4+）。子请求返回2xx允许访问；401/403拒绝并返回对应错误码；其他响应视为错误。401时客户端同时收到子请求的 `WWW-Authenticate` 头。

默认不构建，需编译参数：
```nginx
--with-http_auth_request_module
```

可与 access/basic/jwt 等模块通过 `satisfy` 指令组合。1.7.3 前授权子请求响应不可缓存。

### 示例配置
```nginx
location /private/ {
    auth_request /auth;
    ...
}
location = /auth {
    proxy_pass ...;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
}
```
易错点：子请求需 `proxy_pass_request_body off` 且 `Content-Length` 置空，否则可能转发主体导致认证失败；用 `X-Original-URI` 保留原始 URI。

### 指令
- `auth_request uri | off;` 默认 `off`；上下文 `http/server/location`。启用子请求授权并设置 URI。
- `auth_request_set $variable value;` 授权完成后设置变量，value 可含子请求变量（如 `$upstream_http_*`）。

`ngx_http_auth_require_module`（1.29.0，商业订阅）：基于变量的客户端授权；可结合 `ngx_http_auth_request_module` 或 OIDC 模块提供的变量使用。

指令：
- 语法：`auth_require $value ... [error=4xx | 5xx];`
- 默认：`auth_require off;`
- 上下文：`http`, `server`, `location`, `limit_except`

行为：
- 所有指定变量均非空且非 `"0"` 才放行；否则默认返回 `403`，可用 `error` 参数覆盖。
- 多个 `auth_require` 可分别返回不同错误码。

示例：
```nginx
http {
    oidc_provider my_idp { ... }
    map $oidc_claim_role $admin_role {
        "admin" 1;
    }
    server {
        auth_oidc my_idp;
        location /admin {
            auth_require $admin_role;
        }
    }
}
```

易错点：变量由其他访问模块提供；模块仅商业订阅可用。

**ngx_http_autoindex_module**：处理以 `/` 结尾的请求，生成目录列表。通常在 index 模块找不到索引文件时生效。

```nginx
location / {
    autoindex on;
}
```

指令（上下文均为 http/server/location）：

- `autoindex on|off;` 默认 `off`。启用/禁用目录列表。
- `autoindex_exact_size on|off;` 默认 `on`；仅 HTML 格式。输出精确文件大小，或四舍五入为 KB/MB/GB。
- `autoindex_format html|xml|json|jsonp;` 默认 `html`；1.7.9+。设置目录列表格式。JSONP 格式用 `callback` 请求参数指定回调函数名；参数缺失或为空则用 JSON。XML 输出可用 ngx_http_xslt_module 转换。
- `autoindex_localtime on|off;` 默认 `off`；仅 HTML 格式。时间用本地时区或 UTC。

# ngx_http_browser_module 核心知识点

基于 `User-Agent` 创建变量：
- `$modern_browser`：识别为现代浏览器时等于 `modern_browser_value` 设定的值
- `$ancient_browser`：识别为古老浏览器时等于 `ancient_browser_value` 设定的值
- `$msie`：任意版本 MSIE 时等于 `1`

## 指令
- `ancient_browser string ...;`（http/server/location）：UA 含任一指定子串判为 ancient；`netscape4` 等价于 `^Mozilla/[1-4]`
- `ancient_browser_value string;` 默认 `1`：设置 `$ancient_browser`
- `modern_browser browser version;` 或 `modern_browser unlisted;`（http/server/location）：browser 支持 `msie`、`gecko`、`opera`、`safari`、`konqueror`；版本格式 `X`~`X.X.X.X`，各段上限 `4000`、`99`、`99`、`99`；`unlisted` 未在两者列出时视为现代，无 UA 视为未列出
- `modern_browser_value string;` 默认 `1`：设置 `$modern_browser`；可自定义用于拼接路径，如 `index index.${modern_browser}html index.html;`

## 易错点
- 版本比较按分段数值比较，最多 4 段
- `unlisted` 仅决定“未列出”者的归属，不改变 ancient 判定
- 变量值默认均为 `1`，可自定义用于逻辑或路径拼接

`ngx_http_charset_module`：为 `Content-Type` 响应头添加 charset，可转换字符集。限服务器→客户端单向；仅单字节间或单字节↔UTF-8。

- `charset charset | off;` 默认 `off`；上下文 `http, server, location, if in location`。指定 charset；与 `source_charset` 不同则转换。支持变量 `$charset`，其值须已在配置中出现。映射表见 `conf/koi-win`/`conf/koi-utf`/`conf/win-utf`。
- `charset_map charset1 charset2 { ... };` 上下文 `http`。反向表自动生成；码值十六进制；80-FF 缺失替 `?`（UTF-8→单字节为 `&#XXXX;`）。
- `override_charset on | off;` 默认 `off`；上下文 `http, server, location`。上游已带 charset 时是否转换；开启后以其为源。注意：子请求总转换到主请求字符集。
- `source_charset charset;` 无默认；上下文 `http, server, location`。定义源字符集。

核心知识点：`ngx_http_core_module`（HTTP 核心模块）

- `absolute_redirect on | off;`  
  默认 `on`，上下文：http/server/location。关闭后 nginx 发起的重定向为相对路径。
- `aio on | off | threads[=pool];`  
  默认 `off`，启用异步文件 I/O（FreeBSD/Linux）。Linux 下须配合 `directio` 否则读文件阻塞；`threads` 模式需 `--with-threads` 编译，仅兼容 epoll/kqueue/eventport，多线程发送文件仅支持 Linux。
- `aio_write on | off;`  
  默认 `off`，`aio` 启用时是否用于写文件；目前仅 `aio threads` 生效，且限于写入代理服务器收到的临时文件。
- `alias path;`  
  仅 `location` 上下文，替换 location 匹配的路径。`path` 支持变量（不含 `$document_root`/`$realpath_root`）。用在正则 location 时，正则须含捕获组且 `alias` 引用捕获值。

易错点：
- `alias` 与 `root` 区别：`alias` 将 location 替换为指定路径，`root` 是拼接根目录。
- 正则 location + `alias` 必须使用捕获，否则无法正确映射。

示例：
```nginx
location /i/ {
    alias /data/w3/images/;
}
location ~ ^/users/(.+\.(?:gif|jpe?g|png))$ {
    alias /data/w3/images/$1;
}
```

- **root**：`root path;` 映射 URL 到文件目录，上下文 http/server/location。  
- **auth_delay**：`auth_delay time;` 延迟 401 响应抗时序攻击，默认 `0s`（1.17.10+），仅影响 401。  
- **chunked_transfer_encoding**：`on|off;` 默认 `on`；关闭分块传输适配旧软件。  
- **client_body_buffer_size**：`size;` 默认 `8k|16k`；超出写临时文件。  
- **client_body_in_file_only**：`on|clean|off;` 默认 `off`；`on` 保留临时文件，`clean` 处理完删除。  
- **client_body_in_single_buffer**：`on|off;` 默认 `off`；使用 `$request_body` 时建议开启，减少拷贝。  
- **client_body_temp_path**：`path [l1 [l2 [l3]]];` 默认 `client_body_temp`；支持三级子目录。  
- **client_body_timeout**：`time;` 默认 `60s`；读操作间隔超时返回 408。  
- **client_header_buffer_size**：`size;` 默认 `1k`；头过大时由 `large_client_header_buffers` 分配大缓冲区。  
- 除 `client_header_buffer_size` 上下文为 http/server 外，其余指令均为 http/server/location。

- `ngx_http_dav_module`：通过 WebDAV 支持 `PUT`、`DELETE`、`MKCOL`、`COPY`、`MOVE`，默认不编译，需 `--with-http_dav_module`。注意：依赖额外 WebDAV 方法的客户端不兼容。

```nginx
location / {
    root /data/www;
    client_body_temp_path /data/client_temp;
    dav_methods PUT DELETE MKCOL COPY MOVE;
    create_full_put_path on;
    dav_access group:rw all:r;
}
```

- `create_full_put_path on|off`（默认 `off`）：允许自动创建所有中间目录（WebDAV 默认只允许在已有目录中建文件）。
- `dav_access users:permissions ...`（默认 `user:rw`）：设置新建文件/目录权限；若指定 `group` 或 `all`，可省略 `user`。
- `dav_methods off|method ...`（默认 `off`）：允许指定方法；`off` 拒绝所有该模块处理的方法。
- `min_delete_depth number`（默认 `0`）：请求路径元素数 ≥ 指定值才允许 `DELETE` 删除文件。

易错点：
- `PUT` 上传先写临时文件再重命名；若临时文件与存储目录跨文件系统会变成复制，性能差。建议 `client_body_temp_path` 与存储目录同文件系统。
- `PUT` 可通过 `Date` 请求头指定文件修改时间。
- `min_delete_depth` 示例：`min_delete_depth 4;` 允许删除 `/users/00/00/name`、`/users/00/00/name/pic.jpg`，拒绝删除 `/users/00/00`。

## 多处理模块（MPMs）

- **职责**：绑定端口、接受请求、派生子进程；任意时刻只能加载一个MPM。
- **优势**：跨平台高效（Windows用`mpm_winnt`）；按需定制（高并发选`worker`/`event`，稳定兼容选`prefork`）。
- **默认MPM**：
  - Unix：支持线程+epoll/kqueue → `event`（现代默认）；仅线程 → `worker`；否则 → `prefork`。
  - Windows：`mpm_winnt`；Netware：`mpm_netware`；OS/2：`mpmt_os2`。
- **静态编译**：`configure --with-mpm=NAME`；查看用 `./httpd -l`；切换需重编译。
- **动态加载**：编译时 `--enable-mpms-shared all`；用`LoadModule`切换（如 `LoadModule mpm_event_module modules/mod_mpm_event.so`）；默认MPM写入配置，修改`LoadModule`即可。
- **易错点**：多个MPM导致启动失败：`AH00534: httpd: Configuration error: More than one MPM loaded.`

- nginx：HTTP服务器/反向代理/缓存/负载均衡/TCP-UDP及邮件代理；BSD许可；高并发低资源。
- 核心 HTTP：静态文件 `index`、`autoindex`、`open_file_cache`；反向代理 `proxy` + `proxy_cache`，`upstream` 负载均衡/容错；FastCGI/uwsgi/SCGI/memcached 均支持缓存与 upstream；过滤器 gzip、byte ranges、chunked、XSLT、SSI、image_filter；SSL/TLS + SNI；HTTP/2 加权依赖；HTTP/3。
- 其他 HTTP：虚拟服务器（域名/IP）；`keepalive_timeout`、pipelined；`log_format`、`access_log` 缓冲/轮转/syslog；`error_page`；`rewrite` 正则改写、`geo` 按 IP 分流；访问控制 `access`、`auth_basic`、`auth_request`、`referer`；WebDAV（PUT/DELETE/MKCOL/COPY/MOVE）；FLV/MP4；限速 `limit_rate`、`limit_conn`、`limit_req`；geoip、`split_clients`、`mirror`、Perl、njs。
- 邮件代理：IMAP/POP3/SMTP；外部 HTTP 认证；SSL/STARTTLS。
- stream 模块：TCP/UDP 代理；SSL/SNI；upstream 负载均衡；`access`、`geo`、`limit_conn`；日志/syslog；geoip、`split_clients`、njs。
- 易错点：`proxy_cache` 缓存上游响应，`open_file_cache` 仅缓存静态文件描述符，勿混；stream 与 http 配置独立，指令不通用（如 stream 无 `auth_basic`）；HTTP/3 需 `listen` 单独启用并依赖 SSL 配置。

- **架构**：1 master + N worker，worker 以非特权用户运行。
- **热维护**：支持不中断客户端服务的重配置与可执行文件升级。
- **事件模型**：kqueue (FreeBSD 4.1+)、epoll (Linux 2.6+)、/dev/poll、event ports、select、poll；kqueue 支持 `EV_CLEAR`、`EV_DISABLE`、`NOTE_LOWAT`、`EV_EOF`；epoll 支持 `EPOLLRDHUP` (Linux 2.6.17+, glibc 2.8+)、`EPOLLEXCLUSIVE` (Linux 4.5+, glibc 2.24+)。
- **高效 I/O**：sendfile / sendfile64 / sendfilev；File AIO；DIRECTIO；Accept-filters / TCP_DEFER_ACCEPT。
- **资源占用**：10,000 非活动 HTTP keep-alive 连接约 2.5M 内存；数据拷贝操作最少。
- **已验证平台**：FreeBSD、Linux、Solaris、AIX、HP-UX、macOS、Windows（覆盖主流版本）。

### 核心知识点：Nginx 官方推荐书籍

- **入门与综合**：  
  - `Nginx HTTP Server`（第4版，Packt，英文）——经典入门，覆盖安装、配置、虚拟主机、反代、负载均衡。  
  - `nginx実践入門`（日文）——实践导向。  
  - `实战Nginx`（中文）——早期中文实战。  
  - `Nginx 1 Web Server Implementation Cookbook`（Packt）——常见场景速查。

- **进阶与调优**：  
  - `Mastering NGINX`（第2版）——配置架构与高级负载均衡。  
  - `Nginx High Performance`——性能优化与缓存。  
  - `Nginx Troubleshooting`——故障排查。

- **模块开发**：  
  - `Nginx Module Extension`（Packt）——C模块编写。

- **专项场景**：  
  - `The Complete NGINX Cookbook`（2019版，O'Reilly/F5）——API网关、微服务、K8s、安全。  
  - `Deploying NGINX Plus as an API Gateway`（官方）——NGINX Plus网关、限流。  
  - `Nginx Cookbook`（2017版，Packt）——配置速查。

- **小语种**：  
  - `Nginx richtig konfigurieren`（德文）——WordPress/网站配置。  
  - `Nginx ポケットリファレンス`（日文）——便携指令速查。

**要点**：  
- 优先新版：`Nginx HTTP Server`选第4版（2018），Cookbook选2019版。  
- 官方书目含多语言，多为Packt/O'Reilly出版。  
- 开发模块看`Nginx Module Extension`；API网关用官方电子书+Cookbook。  
- 选书时对照当前Nginx版本（如1.4+与Plus差异）。

## Windows版nginx

- 基于原生 Win32 API（非 Cygwin），仅支持 `select()`/`poll()`（1.15.9+），性能/扩展性有限，视为 **beta**。
- 功能与 UNIX 版基本一致，但缺少：**XSLT filter、image filter、GeoIP 模块、embedded Perl**。

### 安装与运行

下载最新主线版（示例 1.31.4），解压后启动：

```bat
cd c:\
unzip nginx-1.31.4.zip
cd nginx-1.31.4
start nginx
```

查看进程：

```bat
tasklist /fi "imagename eq nginx.exe"
```

- 一个 master 进程 + 一个 worker 进程。
- 启动失败：查 `logs\error.log`；若日志未生成，查 Windows 事件日志。

### 路径与配置

- 相对路径以运行目录为 prefix（如上例 `C:\nginx-1.31.4\`）。
- 配置中路径必须用 **UNIX 风格正斜杠**：

```nginx
access_log   logs/site.log;
root         C:/web/html;
```

### 管理命令（控制台应用，非服务）

| 命令 | 作用 |
|---|---|
| `nginx -s stop` | 快速关闭 |
| `nginx -s quit` | 优雅关闭 |
| `nginx -s reload` | 重载配置，优雅重启 worker |
| `nginx -s reopen` | 重新打开日志文件 |

### 已知问题

- 可启动多个 worker，但只有一个真正干活。
- 不支持 UDP（也因此不支持 QUIC）。

### 未来可能增强

- 作为服务运行；I/O completion ports；单 worker 内多线程。

- njs 是 nginx 的 JavaScript 模块，通过 JS 脚本扩展服务器功能，实现自定义服务端逻辑。
- **引擎弃用**：内置 njs 引擎自 `1.0.0` 弃用，新配置应使用 QuickJS 引擎（`js_engine qjs;`，自 `0.9.1` 起）。
- 相关模块：`ngx_http_js_module`（HTTP）、`ngx_stream_js_module`（流）。
- 典型用途：上游前的复杂访问控制/安全校验、修改响应头、灵活的异步内容处理器和过滤器。

基本 HTTP 示例：

1. 创建脚本 `http.js`：

```js
function hello(r) {
    r.return(200, "Hello world!");
}
export default {hello};
```

2. 配置 `nginx.conf`：

```nginx
load_module modules/ngx_http_js_module.so;
events {}
http {
    js_engine qjs;          # 使用 QuickJS 引擎
    js_import http.js;      # 导入脚本
    server {
        listen 8000;
        location / {
            js_content http.hello;   # 调用导出函数
        }
    }
}
```

- 另有独立命令行工具（`njs` CLI），可脱离 nginx 进行 njs 开发调试。
- 已测试平台：FreeBSD/amd64；Linux/x86、amd64、arm64、ppc64el；Solaris 11/amd64；macOS/x86_64。
- 易错点：脚本必须通过 `export default` 导出；`js_content` 引用格式为 `脚本名.函数名`；`js_engine` 需在 `http` 或 `stream` 上下文配置。

## 版本
- 主线：`nginx-1.31.4`；稳定：`nginx-1.30.4`
- `nginx-1.30.0` 稳定版合入 1.29.x 主要特性

## 安全更新（重点）
- **缓冲区溢出/越界读**：`map` 正则、`rewrite`、`charset`、`proxy_v2`/`grpc`、`scgi`/`uwsgi`、`dav`、`mp4`；`slice` 内存泄漏
- **释放后使用**：`ssi`、`http_v3`、OCSP resolver
- **其他**：HTTP/2 请求注入（proxy）、HTTP/3 地址欺骗、SSL upstream 注入、stream OCSP 绕过、mail 会话认证
- 相关 CVE：`CVE-2026-42533 / 42055 / 42926 / 42945 / 42946 / 40460 / 40701 / 27654 / 27784 / 32647 / 1642 / 28755 / 56434 / 42530 / 60005`
- njs 修复 `js_fetch_proxy` 堆溢出（`CVE-2026-8711`，0.9.9）

## njs 引擎
- `njs-1.0.0`：弃用自研引擎，改用 **QuickJS**；统一异常类；加强 `ngx.fetch()` 校验
- 新语法：可选链、空值合并赋值（`??=`）、逻辑赋值（`||=`/`&&=`）
- WebCrypto：`Ed25519`/`X25519`、`wrapKey()`/`unwrapKey()`、`crypto.randomUUID()`
- 支持 `http`/`stream` 加载 qjs 原生模块

## 新特性
- 默认 upstream 协议改为 `HTTP/1.1` + keep-alive（自 1.29.7）
- HTTP 正向代理：`ngx_http_tunnel_module`（1.31.0）
- Early Hints、后端 HTTP/2、Encrypted ClientHello、Multipath TCP、upstream `sticky`

- 漏洞报告：依 [SECURITY.md](https://github.com/nginx/nginx/blob/master/SECURITY.md) 所列方法。
- 补丁签名：使用 [PGP 公钥](pgp_keys.html) 验证。

- 影响：缓冲区溢出、越界读、释放后使用、空指针解引用、信息泄露/注入；涉及 map/regex、HTTP/3、SSI、mp4、rewrite、charset、dav、scgi/uwsgi、proxy/grpc、OCSP、mail 等模块。
- 升级目标（最低修复版本）：
  - 主线 `1.31.x` → `1.31.3+`
  - 稳定 `1.30.x` → `1.30.4+`
  - 旧分支：`1.29.x`→`1.29.7+`、`1.28.x`→`1.28.3+`、`1.27.x`→`1.27.4+`、`1.26.x`→`1.26.3+`、`1.25.x`→`1.25.4+`
- 高危（major）CVE：
  - `CVE-2026-42533`：map/regex 缓冲区溢出
  - `CVE-2026-42530`：HTTP/3 释放后使用
  - `CVE-2024-24989`：HTTP/3 空指针解引用
  - `CVE-2024-24990`：HTTP/3 释放后使用

## nginx 历史安全漏洞（CVE 汇总）

| CVE | 严重性 | 影响版本 | 修复版本 |
|---|---|---|---|
| CVE-2022-41741（mp4缓冲区溢出） | - | 1.1.3-1.23.1, 1.0.7-1.0.15 | 1.23.2+, 1.22.1+ |
| CVE-2022-41742（mp4内存泄露） | medium | 同上 | 同上 |
| CVE-2021-23017（resolver越界写） | medium | 0.6.18-1.20.0 | 1.21.0+, 1.20.1+ |
| CVE-2019-9511（HTTP/2 CPU耗尽） | medium | 1.9.5-1.17.2 | 1.17.3+, 1.16.1+ |
| CVE-2019-9513（HTTP/2 CPU耗尽） | low | 同上 | 同上 |
| CVE-2019-9516（HTTP/2 内存耗尽） | low | 同上 | 同上 |
| CVE-2018-16843（HTTP/2 内存耗尽） | low | 1.9.5-1.15.5 | 1.15.6+, 1.14.1+ |
| CVE-2018-16844（HTTP/2 CPU耗尽） | low | 同上 | 同上 |
| CVE-2018-16845（mp4内存泄露） | medium | 1.1.3-1.15.5, 1.0.7-1.0.15 | 1.15.6+, 1.14.1+ |
| CVE-2017-7529（range过滤整数溢出） | medium | 0.5.6-1.13.2 | 1.13.3+, 1.12.1+ |
| CVE-2016-4450（请求体写NULL指针） | medium | 1.3.9-1.11.0 | 1.11.1+, 1.10.1+ |

**要点**：及时升级至修复版本；无法升级时使用官方补丁（2022 mp4、2021 resolver、2018 mp4、2017 ranges、2016 write 均提供独立补丁）。注意 mp4 模块漏洞同时影响 1.1.3+ 和旧分支 1.0.7-1.0.15。

## nginx 社区

- NGINX 奉行开源理念，始于 Web server，已扩展至 JavaScript、Kubernetes、API 网关、OpenTelemetry、WebAssembly 等项目。
- 治理：开源承诺与治理详情见 Governance 页面。
- 行为准则：参与社区必须遵守 Code of Conduct（CoC）；违规举报：nginx-oss-community@f5.com。
- 社区空间：
  - GitHub Discussions：https://github.com/nginx/nginx/discussions
  - Community Forum：https://community.nginx.org
  - X.com：https://x.com/nginxorg
  - YouTube：https://www.youtube.com/nginxinc
- 开发参与：
  - 浏览源码：https://github.com/nginx/nginx
  - 报告 Bug：https://github.com/nginx/nginx/issues
  - 提交贡献：docs/contributing_changes.html

- nginx 提供三类版本：**mainline**（主线版，含新功能）、**stable**（稳定版，推荐生产用）、**legacy**（历史旧版）。
- 源码包为 `nginx-<version>.tar.gz`，Windows 版为 `nginx/Windows-<version>.zip`，均附 PGP 签名 `.asc`。
- 下载基础 URL：`https://nginx.org/download/`

```bash
# 下载源码包及签名
wget https://nginx.org/download/nginx-1.30.4.tar.gz
wget https://nginx.org/download/nginx-1.30.4.tar.gz.asc

# 下载 Windows 版
wget https://nginx.org/download/nginx/Windows-1.30.4.zip
```

- 各版本对应 `CHANGES` 文件可查看变更历史（如 `CHANGES-1.30`）。
- 源码仓库：`https://github.com/nginx/nginx`；官网源码：`https://github.com/nginx/nginx.org`
- Linux 发行版提供预编译包，分 stable/mainline 两线，见 `linux_packages.html`。
- 易错点：生产环境选 **stable** 而非 mainline；下载后应校验 `.asc` PGP 签名。
- 当前文档示例版本：mainline 1.31.4、stable 1.30.4、legacy 1.28.3 等。

F5, Inc. 自 2019 年收购 NGINX, Inc. 后成为 NGINX 主要维护者、赞助者与治理方。NGINX® 为 F5 注册商标。

- **企业发行版**：F5 提供 NGINX Plus（商业分发版）。
- **商业支持**：通过 F5 Open Source Subscription Bundles 提供。
- **培训认证**：由 F5 提供 NGINX 官方培训。

- MPM可运行时加载：多MPM动态模块，`LoadModule`选择；Event转正，支持异步I/O。
- 配置：`LogLevel`按模块/目录，`trace1`~`trace8`；请求级`<If>/<ElseIf>/<Else>`；通用表达式解析器统一`SetEnvIfExpr`、`RewriteCond`、`Header`等；`KeepAliveTimeout`毫秒；`NameVirtualHost`废弃；`AllowOverrideList`细粒度控制`.htaccess`；`Define`变量；内存通常低于2.2.x。
- 新模块：`mod_proxy_fcgi/scgi`、`mod_remoteip`、`mod_lua`(实验)、`mod_http2`/`mod_proxy_http2`、`mod_brotli`、`mod_md`、`mod_macro`、`mod_auth_form`/`mod_session`、`mod_ratelimit`、`mod_systemd`。
- 增强：`mod_ssl`：OCSP校验/stapling、memcached共享会话、EC密钥、TLS-SRP；`mod_proxy`：`ProxyPass`在`<Location>`内更快，Unix socket后端；`mod_proxy_balancer`：运行时配置成员、`Drain`模式，可持久化。

- mod_cache：支持HEAD；指令可置于目录级；自定义URL前缀；后端5xx时可提供stale；`X-Cache`头显示HIT/MISS/REVALIDATE。
- mod_include：`<include>`支持`onerror`属性，出错时返回错误文档。
- 头部转环境变量：严格校验，非法字符（含下划线）不转换，防注入，影响mod_cgi等。
- mod_authz_core：`Require`及`<RequireAll>`等容器指令实现复杂授权。
- mod_rewrite：新增`[QSD]`（丢弃查询串）、`[END]`（终止重写）；`RewriteCond`支持布尔表达式；`RewriteMap`可用SQL查询。
- mod_ldap：支持嵌套组；`LDAPConnectionPoolTTL`、`LDAPTimeout`处理空闲连接；`LDAPLibraryDebug`调试。
- mod_info：启动时输出预解析配置到stdout。
- mod_auth_basic：提供伪造basic认证机制（2.4.5+）。
- 程序增强：`fcgistarter`启动FastCGI；`htcacheclean`列出/删除缓存URL、大小按块取整、支持inode限制；`rotatelogs`创建日志符号链接、调用轮转后脚本；`htpasswd`/`htdbm`支持bcrypt（2.4.4+）。
- 模块开发者：新增`check_config`钩子，在`pre_config`和`open_logs`之间，`-t`时在`test_config`之前。

## 安全要点

**保持更新**
- 订阅 Apache 及发行版安全公告；多数入侵源于 CGI/附加代码或 OS 漏洞。

**DoS 缓解**
- 防火墙限单 IP 并发，对 DDoS 无效。
- 关键指令：
  - `RequestReadTimeout`：限请求时间
  - `TimeOut`：DoS 时调低至数秒（影响长 CGI）
  - `KeepAliveTimeout` 调低或 `KeepAlive off`
  - `LimitRequestBody`/`LimitRequestFields`/`LimitRequestFieldSize`/`LimitRequestLine`/`LimitXMLRequestBody`：限制输入消耗
  - `AcceptFilter`：默认启用，可能需调内核
  - `MaxRequestWorkers`：调优并发上限
  - 用线程化 MPM（`event` 异步处理）

**ServerRoot 目录权限**
- 所有目录及父目录仅 root 可写：

```bash
mkdir /usr/local/apache
cd /usr/local/apache
mkdir bin conf logs
chown 0 . bin conf logs
chgrp 0 . bin conf logs
chmod 755 . bin conf logs
cp httpd /usr/local/apache/bin
chown 0 /usr/local/apache/bin/httpd
chgrp 0 /usr/local/apache/bin/httpd
chmod 511 /usr/local/apache/bin/httpd
```

- 非 root 若可修改 root 执行/写入的文件（替换 `httpd`、日志符号链接）→ 提权。

**SSI**
- SSI 文件均需解析，负载高；`exec cmd` 可执行任意程序（Apache 用户权限）。
- 启用 `suexec` 隔离危害。
- 避免对 `.html`/`.htm` 启用 SSI，改用 `.shtml`。

- **禁用 SSI 执行**：将 `Options` 指令中的 `Includes` 改为 `IncludesNOEXEC`，禁止脚本/程序执行；但 `<!--#include virtual="..." -->` 仍可执行 `ScriptAlias` 目录中的 CGI 脚本。

- **CGI 通用安全**：必须信任脚本作者或能审查安全漏洞；CGI 以 Web 服务器用户权限运行，可执行任意命令，风险极高。多脚本同用户运行可能互相冲突。可用 `suEXEC`（Apache 内置）或 `CGIWrap` 以不同用户运行。

- **非脚本别名 CGI**（任意目录允许 CGI）仅在以下情况考虑：信任用户；站点安全已极差；无用户且无人访问。

- **脚本别名 CGI**：将 CGI 限制在专用目录，管理员可控制内容，比非别名方式更安全；但需信任目录写权限者或逐一审查脚本。多数站点采用此方式。

- **其他动态内容来源**：嵌入式脚本引擎（`mod_php`、`mod_perl`、`mod_tcl`、`mod_python`）以服务器自身身份（`User` 指令）运行，可访问服务器用户能访问的一切；即便引擎有限制，仍应假设不安全。

- **动态内容安全原则**：
  - 最小化脚本/应用权限
  - 验证和清理所有用户输入
  - 保持框架及依赖更新
  - 审查框架安全配置（默认不一定安全）
  - 可在 Apache 层使用 Web 应用防火墙（如 `ModSecurity`）过滤 HTTP 流量

- **保护系统设置**：禁止 `.htaccess` 覆盖安全配置：
  ```apache
  <Directory "/">
      AllowOverride None
  </Directory>
  ```
  注意：Apache 2.3.9 起这是默认设置。

- `server_name` 匹配优先级：精确名 > 开头通配 `*.example.org` > 结尾通配 `mail.*` > 正则（配置顺序，首个生效）。

- 通配 `*` 仅在开头/结尾且须在点边界；`www.*.example.org` 非法，用 `~^www\..+\.example\.org$`。`.example.org` 同时匹配 `example.org` 和 `*.example.org`。

- 正则以 `~` 开头，必须加 `^` `$` 锚点，点号转义 `\.`。含 `{` `}` 加引号，否则报错 `not terminated by ";"`。

- 命名捕获：
```nginx
server_name ~^(www\.)?(?<domain>.+)$;
root /sites/$domain;
```
旧 PCRE 用 `?P<name>`；慎用数字捕获 `$2`。

- 特殊名：`""` 匹配无 Host 头（未定义时默认空名）；`$hostname` 机器主机名；IP 匹配 IP 请求；`_` 仅作无效 catch-all。

- 默认服务器由 `listen ... default_server` 决定，与 `server_name` 无关（`*` 已废弃）。

- IDN 用 Punycode：
```nginx
server_name xn--e1afmkfd.xn--80akhbyknj4f;
```

- 选择阶段：SSL SNI → 请求行 → Host 头 → 空名。

- **SNI 生效前指令**：`ssl_protocols` 仅底层库支持（OpenSSL 1.1.1+、BoringSSL、AWS-LC）时才可随虚拟服务器配置；否则只能在默认服务器设置。`ssl_session_cache/tickets/timeout`、`ssl_early_data` 只能为默认服务器指定。
- **请求处理早期指令**：`client_header_buffer_size`、`merge_slashes` 在读取请求行前用默认/SNI 配置；`ignore_invalid_headers`、`large_client_header_buffers`、`underscores_in_headers` 生效取决于是否已按请求行或 `Host` 更新配置。`error_page` 由当前服务器处理。
- **哈希表优化**：精确名、前导通配符、后导通配符分别存于三个哈希表；查找顺序：精确名 → 前导通配符（`*.example.org`） → 后导通配符（`www.example.*`）。通配符匹配比精确名慢，正则最慢。
- **特殊通配符**：`.example.org` 存于通配符哈希表，非精确名表。优先用精确名：

```nginx
server {
    listen  80;
    server_name  example.org  www.example.org  *.example.org;
}
```

- **长域名调整**：大量/超长名称时设置 `server_names_hash_max_size`、`server_names_hash_bucket_size`（默认 32/64，依 CPU 缓存行）。bucket=32 且含 `too.long.server.name.example.org` 时启动失败，提示 `could not build the server_names_hash, you should increase server_names_hash_bucket_size: 32`。

**nginx 哈希表设置**

- 用途：快速处理静态数据集（server names、map 指令值、MIME types、请求头名）。
- 启动/重配置时，nginx 选择最小表大小，使同哈希值键所在桶不超 `hash bucket size`；表大小以桶为单位，持续调整至超过 `hash max size`。
- 多数哈希有对应指令，如 server names 哈希：`server_names_hash_max_size`、`server_names_hash_bucket_size`。
- `hash bucket size` 对齐至 CPU 缓存行倍数，减少内存访问、加速键查找；等于一个缓存行时，最坏查找仅 2 次内存访问（定位桶地址 + 桶内查找）。
- 易错点：nginx 报错要求增大 max size 或 bucket size 时，应优先增大 max size。

## 支持 QUIC 和 HTTP/3

- nginx ≥1.25.0，模块 `ngx_http_v3_module`，Linux 二进制包内置。
- 构建需 OpenSSL 3.5.1+，或 BoringSSL/LibreSSL/QuicTLS；必须加 `--with-http_v3_module`：
```bash
./configure --with-http_v3_module --with-cc-opt="-I../boringssl/include" --with-ld-opt="-L../boringssl/build -lstdc++"
```
- 配置：
```nginx
listen 443 quic reuseport;   # 多 worker 建议 reuseport
quic_retry on;               # 地址验证
ssl_early_data on;           # 0-RTT
quic_gso on;                 # 默认关闭，需网卡支持
quic_host_key <filename>;    # 令牌主机密钥
```
- QUIC 要求 TLSv1.3；`ssl_protocols` 默认已启用。
- 排查：用 `nginx -V` 确认 SSL 库；先用 ngtcp2 客户端测试，排除浏览器证书干扰；编译 `--with-debug` 并过滤 `quic` 日志。
- 深度调试宏：`NGX_QUIC_DEBUG_PACKETS`、`NGX_QUIC_DEBUG_FRAMES`、`NGX_QUIC_DEBUG_ALLOC`、`NGX_QUIC_DEBUG_CRYPTO`：
```bash
./configure --with-http_v3_module --with-debug --with-cc-opt="-DNGX_QUIC_DEBUG_PACKETS -DNGX_QUIC_DEBUG_CRYPTO"
```

**操作系统要求**
- 支持 Windows 2000+（需最新 Service Pack）；Apache >2.2 不支持更早系统。
- 官方仅源码；二进制可自编译或从 Apache Lounge/WampServer 获取。

**Windows 配置**
- 配置在 `conf/`；`ServerRoot` 需与实际安装路径匹配。
- 多线程：父进程 + 单子进程，每请求由子进程线程处理。

**进程指令**
- `MaxConnectionsPerChild`：默认 `0`；除非内存泄漏否则不改。
- `ThreadsPerChild`：默认 `150`；线程数=最大并发。

**路径/文件名**
- 路径用 `/`，反斜杠会被转义。
- 文件名系统不敏感但内部映射敏感；`<Location>`/`Alias`/`ProxyPass` 敏感，用 `<Directory>` 限制。
- 强制小写 URL：
```
RewriteEngine On
RewriteMap lowercase int:tolower
RewriteCond "%{REQUEST_URI}" "[A-Z]"
RewriteRule "(.*)" "${lowercase:$1}" [R,L]
```
- 仅日志/缓存目录需写权限；根到叶每层目录需读/列目录/遍历权限。

**模块/扩展**
- 运行时加载：`LoadModule status_module "modules/mod_status.so"`
- 可加载 ISAPI 扩展；**不能**加载 ISAPI Filters，部分 ISAPI Handlers 不工作。

**其他**
- `ScriptInterpreterSource`：CGI 解释器查找。
- `AccessFilename`：重命名 `.htaccess`。
- 启动错误写入 Windows 事件日志。

## httpd 作为 Windows NT 服务

**管理工具**：Apache Service Monitor 查看/管理所有 httpd 服务。

**安装/卸载**（`bin` 下执行）：
```bash
httpd.exe -k install -n "MyServiceName" -f "c:\files\my.conf"
httpd.exe -k uninstall -n "MyServiceName"
```
默认服务名 `Apache2.4`，默认配置 `conf\httpd.conf`。

**启停/重启/测试**：
```bash
httpd.exe -k start -n "MyServiceName"
httpd.exe -k stop -n "MyServiceName"
httpd.exe -k shutdown -n "MyServiceName"
httpd.exe -k restart -n "MyServiceName"
httpd.exe -n "MyServiceName" -t   # 启动前测试配置
```

**服务账户（易错）**：
- 默认 `LocalSystem`：本地权限极大，但**无 Windows 网络权限**（文件系统、命名管道、DCOM、RPC）；**严禁**授予网络权限。
- 需访问网络资源时创建独立域用户：
  1. 授予 `Log on as a service`、`Act as part of the operating system`；确认属于 `Users` 组。
  2. `htdocs`、`cgi-bin`、`httpd.exe` 授予 RX；`logs` 授予 RWXD。
  3. 建议 Apache2.4 整个目录 RX（`logs` 除外），`logs` 至少 RWXD。
  4. 用该账户登录验证：执行脚本、读取网页、控制台启动 httpd。
- **错误码 2186**：`Log On As` 配置有误，httpd 无法访问所需资源。

## Nginx HTTP 负载均衡

- 方法：默认 `round-robin` 轮询；`least-connected`（指令 `least_conn;` 按活动连接数）；`ip-hash`（指令 `ip_hash;` 按客户端 IP 固定同一服务器）。

```nginx
http {
    upstream myapp1 {
        server srv1.example.com;
        server srv2.example.com;
    }
    server {
        listen 80;
        location / { proxy_pass http://myapp1; }
    }
}
```

- 切换方法：在 `upstream` 块添加 `least_conn;` 或 `ip_hash;`。
- 协议扩展：后端为 HTTPS 时 `proxy_pass` 用 `https`；其他协议分别对应 `fastcgi_pass`、`uwsgi_pass`、`scgi_pass`、`memcached_pass`、`grpc_pass`。
- 权重：`server srv1.example.com weight=3;`，每 5 个请求 srv1 收 3 个、srv2 收 1 个；权重适用于所有方法。
- 易错点：轮询/least_conn 不保证会话固定，需用 `ip_hash`；`ip_hash` 仅当服务器不可用时才切换目标。
- 健康检查（被动）：服务器响应出错即标记失败，nginx 暂时不再转发。

- `max_fails`：在 `fail_timeout` 周期内连续失败次数上限，默认 `1`；设为 `0` 禁用健康检查。
- `fail_timeout`：服务器被标记为失败的时长；超时后以真实客户端请求探测，成功即恢复存活。
- 其他负载均衡指令：`proxy_next_upstream`、`backup`、`down`、`keepalive`。
- NGINX Plus 提供应用级健康检查、监控及动态配置。

```
upstream backend {
    server 10.0.0.1 max_fails=2 fail_timeout=30s;
}
```

- WebSocket 代理利用 HTTP/1.1 协议升级机制（101 Switching Protocols）。
- `Upgrade` 是 **hop-by-hop** 头，反向代理默认不会传递给后端，需显式设置。

```nginx
location /chat/ {
    proxy_pass http://backend;
    # 1.29.7 之前必须显式指定 HTTP/1.1
    # proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

- 复杂场景：根据客户端请求是否含 `Upgrade` 头动态设置 `Connection`：

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }
    server {
        location /chat/ {
            proxy_pass http://backend;
            # proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
        }
    }
}
```

- 默认后端 60 秒无数据则断开连接，用 `proxy_read_timeout` 增加超时，或让后端定期发送 WebSocket ping 帧保活。

---
来源：consolidated/services/Web 服务器（Nginx 与 Apache）.md