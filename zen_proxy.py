"""OpenCode Zen 会话标识替换代理

opencode 客户端 -> 本代理(保留字段并替换身份值) -> https://opencode.ai/zen/v1

策略:
    - 识别现有会话标识头, 用假标识替换, 不剥离
    - 同一会话在轮换窗口内映射到同一假标识(不同会话互不相同), 保持请求关联性
    - 默认每 10 分钟整批轮换一次, 窗口结束后生成全新假标识(--rotation 调整)
    - 保留客户端和请求体结构, 避免 Zen 将请求识别为匿名请求而被限流
    - 插件提供轮次标记时, 同一用户消息保持稳定, 新消息使用全新假标识

用法:
    python zen_proxy.py --port 8643
    opencode.jsonc 中 opencode(Zen) provider baseURL 指向 http://127.0.0.1:8643/v1
    上游默认自动走系统/环境代理(Windows 注册表 + HTTP(S)_PROXY), --direct 强制直连,
    --proxy http(s)://host:port 可显式指定代理。

    SSE 流式响应实时透传。上游读超时默认关闭(0), 避免长思考断流,
    --timeout N 可设秒级超时; --keepalive 默认每 15 秒向下游发 SSE 注释心跳,
    保持 opencode 客户端连接在静默期不超时。
"""

import argparse
import base64
import errno
import json
import os
import random
import select
import socket
import ssl
import string
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.client import HTTPConnection, HTTPSConnection, IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP_HEADERS = {
    "host", "connection", "transfer-encoding", "content-length",
    "accept-encoding", "expect", "keep-alive", "proxy-connection", "upgrade",
}

DEFAULT_REWRITE_HEADERS = {
    "x-opencode-session": "ses_",
    "x-session-id": "ses_",
    "x-session-affinity": "ses_",
    "x-parent-session-id": "ses_",
    "x-opencode-project": "proj_",
    "x-opencode-directory": "dir_",
    "x-opencode-workspace": "wrk_",
    "x-opencode-request": "req_",
    "x-opencode-request-id": "req_",
    "x-request-id": "req_",
}
SESSION_HEADERS = {"x-opencode-session", "x-session-id", "x-session-affinity"}
REQUEST_HEADERS = {"x-opencode-request", "x-opencode-request-id", "x-request-id"}
ROUND_HEADER = "x-zen-proxy-round"


class IdentityMapper:
    def __init__(self, rotation):
        self.rotation = rotation
        self.lock = threading.Lock()
        self.epoch = None
        self.map = {}

    def _current_epoch(self):
        if self.rotation <= 0:
            return 0
        return int(time.time() // self.rotation)

    def _refresh_epoch(self):
        epoch = self._current_epoch()
        if epoch != self.epoch:
            self.epoch = epoch
            self.map = {}

    def fake(self, real, prefix, scope=""):
        if not real:
            return real
        with self.lock:
            self._refresh_epoch()
            key = (scope, prefix, real)
            fake = self.map.get(key)
            if fake is None:
                fake = prefix + "".join(random.choices(string.ascii_letters + string.digits, k=22))
                self.map[key] = fake
            return fake

    def fake_group(self, values, prefix, scope=""):
        values = [value for value in values if value]
        if not values:
            return ""
        with self.lock:
            self._refresh_epoch()
            fake = next((self.map.get((scope, prefix, value)) for value in values
                         if self.map.get((scope, prefix, value))), None)
            if fake is None:
                fake = prefix + "".join(random.choices(string.ascii_letters + string.digits, k=22))
            for value in values:
                self.map[(scope, prefix, value)] = fake
            return fake

    def random_id(self, prefix):
        return prefix + "".join(random.choices(string.ascii_letters + string.digits, k=22))

    def size(self):
        with self.lock:
            return len(self.map)


upstream_host = "opencode.ai"
upstream_port = 443
upstream_prefix = "/zen/v1"
upstream_ssl = True
identity_mapper = IdentityMapper(600)
rewrite_enabled = True
strip_headers = set()
sanitize_body = True
quiet = False
inject_client = "cli"
# 上游代理: ""=自动检测系统/环境代理, "direct"=强制直连, 其它=http(s)://host:port 显式指定
proxy_setting = ""
# 额外注入的请求头, 形如 "Name: value"(可由 --extra-header 多次指定)
extra_headers = []
# 上游 socket 超时(秒), 0 = 永不超时(避免长思考断流)
upstream_timeout = 0
# 向下游 SSE 心跳间隔(秒), 0 = 关闭
sse_keepalive = 15
# 上游错误日志始终开启; --verbose 额外打印每次请求的连接细节(对端/TLS/证书)
verbose_log = False
# 上游错误统计: (阶段, 异常类型) -> 累计次数
error_stats = {}
error_stats_lock = threading.Lock()
# 上游瞬态错误(握手 alert/连接重置/远端提前断开等)自动重试次数, 0 = 不重试
upstream_retries = 2


def _is_retryable(err):
    """判断上游错误是否值得重试: 握手/连接类瞬态错误重试, 证书类确定性错误不重试。"""
    if isinstance(err, ssl.SSLCertVerificationError):
        return False
    if isinstance(err, (ssl.SSLError, ConnectionError, socket.timeout)):
        return True
    if isinstance(err, OSError):
        return err.errno in (errno.ECONNRESET, errno.ECONNABORTED, errno.EPIPE,
                             errno.ETIMEDOUT, errno.ECONNREFUSED, errno.EHOSTUNREACH,
                             errno.ENETUNREACH)
    return False


def _conn_peer(conn):
    """尽力获取连接对端信息: 地址、TLS 版本、证书签发组织; 拿不到则省略对应字段。"""
    sock = getattr(conn, "sock", None)
    if sock is None:
        return None
    try:
        peer = sock.getpeername()
        peer_str = f"{peer[0]}:{peer[1]}"
    except OSError:
        peer_str = "?"
    try:
        tls = sock.version() or "no-tls"
    except Exception:
        tls = "?"
    issuer = None
    try:
        cert = sock.getpeercert()
        if cert:
            issuer = dict(x[0] for x in cert.get("issuer", []))
            issuer = issuer.get("organizationName") or issuer.get("commonName")
    except Exception:
        pass
    parts = [f"peer={peer_str}", f"tls={tls}"]
    if issuer:
        parts.append(f"issuer={issuer}")
    return " ".join(parts)


def _metadata_key(key):
    return "".join(ch.lower() for ch in str(key) if ch.isalnum())


def _metadata_prefix(key):
    normalized = _metadata_key(key)
    if "request" in normalized:
        return "req_"
    if "project" in normalized:
        return "proj_"
    if "session" in normalized or "parent" in normalized:
        return "ses_"
    if any(part in normalized for part in (
        "user", "email", "account", "organization", "workspace", "directory", "device", "client", "installation",
    )):
        return "usr_"
    return None


def _fake_value(value, prefix, scope):
    if value is None:
        return value
    text = str(value)
    return identity_mapper.fake(text, prefix, scope) if text else identity_mapper.random_id(prefix)


def _sanitize_metadata(value, scope, key=""):
    prefix = _metadata_prefix(key)
    if prefix and value is not None and not isinstance(value, (dict, list)):
        return _fake_value(value, prefix, scope)
    if isinstance(value, dict):
        return {name: _sanitize_metadata(item, scope, name) for name, item in value.items()}
    if isinstance(value, list):
        return [_sanitize_metadata(item, scope, key) for item in value]
    return value


def _sanitize_request_body(obj, scope):
    for key in list(obj):
        normalized = _metadata_key(key)
        if normalized == "user":
            value = obj[key]
            if value is not None and not isinstance(value, (dict, list)):
                obj[key] = _fake_value(value, "usr_", scope)
            else:
                obj[key] = _sanitize_metadata(value, scope, key)
        elif normalized == "metadata":
            obj[key] = _sanitize_metadata(obj[key], scope, key)
    return obj


class ZenProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._forward()

    def do_POST(self):
        self._forward()

    def do_OPTIONS(self):
        self._forward()

    def log_message(self, format, *args):
        pass

    def _forward(self):
        if os.environ.get("ZEN_PROXY_DEBUG"):
            print(f"[fwd] {self.command} {self.path}", file=sys.stderr, flush=True)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))

        split = urllib.parse.urlsplit(self.path)
        path = split.path
        if self.command == "GET" and path == "/__zen_proxy_health":
            self.close_connection = True
            return self._send_json(200, {
                "service": "zen_proxy",
                "pid": os.getpid(),
                "rotation": identity_mapper.rotation,
            })
        if path.startswith("/v1"):
            path = path[3:]
        upstream_path = upstream_prefix + path
        if split.query:
            upstream_path += "?" + split.query

        round_scope = self.headers.get(ROUND_HEADER, "")
        session_values = []
        session_header_present = False
        for key, value in self.headers.items():
            if key.lower() in SESSION_HEADERS:
                session_header_present = True
                if value:
                    session_values.append(value)
        session_fake = identity_mapper.fake_group(session_values, "ses_", round_scope)
        if session_header_present and not session_fake:
            session_fake = identity_mapper.random_id("ses_")
        request_fake = identity_mapper.random_id("req_")

        headers = {}
        for key, value in self.headers.items():
            lkey = key.lower()
            if lkey in HOP_HEADERS or lkey in strip_headers or lkey == ROUND_HEADER:
                continue
            if rewrite_enabled:
                if lkey in SESSION_HEADERS:
                    value = session_fake
                elif lkey == "x-parent-session-id":
                    value = _fake_value(value, "ses_", round_scope)
                elif lkey == "x-opencode-project":
                    value = _fake_value(value, "proj_", round_scope)
                elif lkey == "x-opencode-directory":
                    value = _fake_value(value, "dir_", round_scope)
                elif lkey == "x-opencode-workspace":
                    value = _fake_value(value, "wrk_", round_scope)
                elif lkey in REQUEST_HEADERS:
                    value = request_fake
            headers[lkey] = value

        if inject_client and not headers.get("x-opencode-client", "").strip():
            headers["x-opencode-client"] = inject_client

        for h in extra_headers:
            name, sep, value = h.partition(":")
            name = name.strip()
            if sep and name:
                headers[name.lower()] = value.strip()

        if not quiet:
            self._log_request(headers, upstream_path)

        if body and sanitize_body:
            try:
                obj = json.loads(body)
            except ValueError:
                obj = None
            if isinstance(obj, dict):
                _sanitize_request_body(obj, round_scope)
                body = json.dumps(obj).encode()

        resp = None
        conn = None
        last_err = None
        for attempt in range(upstream_retries + 1):
            conn = _upstream_connection()
            sent = False
            try:
                if verbose_log:
                    conn.connect()
                    print(f"[{time.strftime('%H:%M:%S')}] CONNECT {self.command} {upstream_path} "
                          + (_conn_peer(conn) or "peer=?"), file=sys.stderr, flush=True)
                if os.environ.get("ZEN_PROXY_DEBUG"):
                    print(f"[debug] OUT {self.command} {upstream_path} headers={headers!r}", file=sys.stderr, flush=True)
                conn.request(self.command, upstream_path, body=body if body else None, headers=headers)
                sent = True
                resp = conn.getresponse()
            except (OSError, ValueError, IncompleteRead) as e:
                last_err = e
                phase = "response" if sent else ("connect" if verbose_log else "request")
                self._log_upstream_error(phase, e, conn)
                try:
                    conn.close()
                except OSError:
                    pass
                if not _is_retryable(e) or attempt >= upstream_retries:
                    return self._send_json(502, {
                        "error": (f"cannot reach upstream: {e}" if phase != "response"
                                  else f"upstream error: {e}")})
                print(f"[{time.strftime('%H:%M:%S')}] RETRY attempt={attempt + 1}/{upstream_retries} "
                      + f"phase={phase} err={type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)
                time.sleep(0.3 * (attempt + 1))
            else:
                break
        assert resp is not None and conn is not None  # 循环必 break 或 return
        content_type = resp.getheader("Content-Type", "")
        self._log_status = resp.status

        self.close_connection = True
        streaming = "text/event-stream" in content_type
        self.send_response(resp.status)
        for key, value in resp.getheaders():
            if key.lower() in HOP_HEADERS:
                continue
            self.send_header(key, value)
        self.send_header("Connection", "close")
        if streaming:
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._stream_body(conn, resp)
        else:
            try:
                resp_body = resp.read()
            except (OSError, ValueError):
                resp_body = b""
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            try:
                self.wfile.write(resp_body)
            except OSError:
                pass
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _stream_body(self, conn, resp):
        """透传 SSE 流。
        主线程用阻塞 read1 实时转发(不攒 8KB、每块 flush), 上游读超时默认
        关闭(0), 避免长思考/长停顿被掐断; 由 keepalive 线程用 select 监控
        上游静默, 超时向下游发 SSE 注释心跳, 防止 opencode 客户端因长时间
        无数据而自行断开(--keepalive, 0=关)。--timeout 为上游空闲上限,
        超过则主动结束流(0=永不)。"""
        sock = conn.sock
        keepalive = sse_keepalive
        hard = upstream_timeout  # 0 = 永不
        stop = threading.Event()
        lock = threading.Lock()
        last_data = [time.time()]
        last_ka = [0.0]

        def keepalive_loop():
            try:
                while not stop.is_set():
                    r, _, _ = select.select([sock], [], [], 0.1)
                    if r:
                        continue
                    now = time.time()
                    idle = now - last_data[0]
                    if hard and idle >= hard:
                        if os.environ.get("ZEN_PROXY_DEBUG"):
                            print("[stream] idle timeout", file=sys.stderr, flush=True)
                        stop.set()
                        try:
                            conn.close()
                        except OSError:
                            pass
                        break
                    if keepalive > 0 and idle >= keepalive and now - last_ka[0] >= keepalive:
                        last_ka[0] = now
                        with lock:
                            if not stop.is_set():
                                self._write_chunk(b": zen-proxy keepalive\n\n")
            except (OSError, ValueError):
                pass

        ka = None
        if keepalive > 0 or hard:
            ka = threading.Thread(target=keepalive_loop, daemon=True)
            ka.start()
        try:
            while True:
                chunk = resp.read1(8192)
                if not chunk:
                    break
                last_data[0] = time.time()
                with lock:
                    self._write_chunk(chunk)
        except (OSError, ValueError, IncompleteRead):
            if os.environ.get("ZEN_PROXY_DEBUG"):
                print("[stream] ended early", file=sys.stderr, flush=True)
        finally:
            stop.set()
            if ka is not None:
                ka.join(timeout=(keepalive or hard or 1) + 2)
            try:
                with lock:
                    self._write_chunk(b"")
            except OSError:
                pass

    def _write_chunk(self, data):
        if data:
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        else:
            self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _log_request(self, headers, upstream_path):
        ts = time.strftime("%H:%M:%S")
        parts = [f"[{ts}] {self.command} {upstream_path}"]
        if rewrite_enabled:
            mapping = []
            for real in (self.headers.get("X-Opencode-Session"),
                         self.headers.get("X-Session-ID")):
                if real:
                    mapping.append(real)
            mapped = headers.get("x-opencode-session") or headers.get("x-session-id")
            if mapping:
                parts.append(f"ses {sorted(set(mapping))} -> {mapped}")
            project = self.headers.get("X-Opencode-Project")
            if project:
                parts.append(f"proj {project} -> {headers.get('x-opencode-project')}")
        parts.append(f"status={getattr(self, '_log_status', 'pending')}")
        print(" | ".join(parts), flush=True)

    def _log_upstream_error(self, phase, err, conn):
        """上游错误日志(始终开启): 阶段/异常类型/完整消息/对端信息/请求上下文/累计次数。"""
        ts = time.strftime("%H:%M:%S")
        kind = type(err).__name__
        with error_stats_lock:
            key = (phase, kind)
            n = error_stats.get(key, 0) + 1
            error_stats[key] = n
        info = _conn_peer(conn)
        print(f"[{ts}] UPSTREAM-ERROR phase={phase} err={kind}: {err}"
              + (f" [{info}]" if info else "")
              + f" req={self.command} {urllib.parse.urlsplit(self.path).path}"
              + f" client={self.client_address[0]}:{self.client_address[1]}"
              + f" occurrence={n}", file=sys.stderr, flush=True)


def _get_system_proxy_from_registry():
    """绕过 getproxies 的 NO_PROXY 短路，直接读注册表获取系统代理。"""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
            try:
                enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            except FileNotFoundError:
                enabled = 0
            if not enabled:
                return ""
            try:
                server, _ = winreg.QueryValueEx(key, "ProxyServer")
            except FileNotFoundError:
                return ""
            server = (server or "").strip()
            if not server:
                return ""
            # 可能为 "http=127.0.0.1:1086;https=127.0.0.1:1086" 或单一 "127.0.0.1:1086"
            for part in server.split(";"):
                part = part.strip()
                if not part:
                    continue
                if "=" in part:
                    proto, addr = part.split("=", 1)
                    if proto.lower() in ("https", "http"):
                        return "http://" + addr if "://" not in addr else addr
                else:
                    return "http://" + part if "://" not in part else part
            return ""
    except Exception:
        return ""


def _resolve_proxy():
    """解析上游代理设置。

    返回 (host, port, ssl, headers) 表示经该代理 CONNECT 隧道转发;
    返回 None 表示直连。
    """
    setting = proxy_setting
    if setting == "direct":
        return None
    explicit = bool(setting)
    url = setting
    if not url:
        proxies = urllib.request.getproxies()
        url = proxies.get("https") or proxies.get("http") or ""
        # 兼容 NO_PROXY 导致 getproxies 短路不读注册表的缺陷
        if not url:
            url = _get_system_proxy_from_registry()
    if not url:
        return None
    if not explicit and urllib.request.proxy_bypass(upstream_host):
        return None
    p = urllib.parse.urlsplit(url)
    if not p.hostname:
        return None
    port = p.port or (443 if p.scheme == "https" else 8080)
    headers = {}
    if p.username:
        cred = urllib.parse.unquote(p.username) + ":" + urllib.parse.unquote(p.password or "")
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(cred.encode()).decode()
    return p.hostname, port, p.scheme == "https", headers


def _upstream_connection():
    proxy = _resolve_proxy()
    timeout = upstream_timeout or None
    if proxy is None:
        if upstream_ssl:
            return HTTPSConnection(upstream_host, upstream_port, timeout=timeout,
                                   context=ssl.create_default_context())
        return HTTPConnection(upstream_host, upstream_port, timeout=timeout)
    host, port, ssl_proxy, headers = proxy
    # 关键: 隧道连接类取决于"上游"是否 TLS(CONNECT 后需对上游再握手 TLS),
    # 而非代理自身是否 TLS —— http 代理只做明文 CONNECT 转发,
    # 对 https 上游必须用 HTTPSConnection, 否则明文请求打到 443 会得 400。
    if upstream_ssl:
        conn = HTTPSConnection(host, port, timeout=timeout,
                               context=ssl.create_default_context())
    else:
        conn = HTTPConnection(host, port, timeout=timeout)
    conn.set_tunnel(upstream_host, upstream_port, headers=headers or None)
    return conn


def main():
    parser = argparse.ArgumentParser(description="OpenCode Zen session identity randomizing proxy")
    parser.add_argument("--port", type=int, default=8643)
    parser.add_argument("--upstream-host", default="opencode.ai")
    parser.add_argument("--upstream-port", type=int, default=443)
    parser.add_argument("--upstream-prefix", default="/zen/v1")
    parser.add_argument("--no-ssl", action="store_true")
    parser.add_argument("--no-rewrite", action="store_true",
                        help="pass session identifying headers through unchanged")
    parser.add_argument("--strip", action="append", default=[],
                        help="additional header names to remove entirely (lowercase)")
    parser.add_argument("--no-sanitize-body", action="store_true",
                        help="do not sanitize identity values in request body")
    parser.add_argument("--quiet", action="store_true",
                        help="do not log per-request lines")
    parser.add_argument("--verbose", action="store_true",
                        help="log upstream connection details (peer address, TLS version, cert issuer) per request")
    parser.add_argument("--inject-client", default="cli",
                        help="x-opencode-client value to inject when missing (empty = disable)")
    parser.add_argument("--rotation", type=int, default=600,
                        help="seconds between fake identity rotation (0 = never)")
    parser.add_argument("--extra-header", action="append", default=[],
                        help="inject extra request header 'Name: value' (repeatable), e.g. 'x-egress-token: xxx'")
    parser.add_argument("--proxy", default="",
                        help="upstream proxy: 留空=自动检测系统/环境代理, 'direct'=强制直连, 或 http(s)://host:port 显式指定")
    parser.add_argument("--direct", action="store_true",
                        help="force direct connection, ignore system proxy")
    parser.add_argument("--timeout", type=int, default=0,
                        help="upstream socket timeout in seconds (0 = never, avoid cutting long reasoning streams)")
    parser.add_argument("--keepalive", type=int, default=15,
                        help="send SSE keepalive comment to client every N idle seconds (0 = off)")
    parser.add_argument("--retries", type=int, default=2,
                        help="retries on transient upstream errors (TLS alert/conn reset/early close); 0 = no retry")
    args = parser.parse_args()

    global upstream_host, upstream_port, upstream_prefix, upstream_ssl
    global identity_mapper, rewrite_enabled, strip_headers, sanitize_body, quiet, inject_client, proxy_setting, extra_headers
    global upstream_timeout, sse_keepalive, verbose_log
    global upstream_retries
    upstream_host = args.upstream_host
    upstream_port = args.upstream_port
    upstream_prefix = args.upstream_prefix
    upstream_ssl = not args.no_ssl
    identity_mapper = IdentityMapper(args.rotation)
    rewrite_enabled = not args.no_rewrite
    strip_headers = {name.lower() for name in args.strip}
    sanitize_body = not args.no_sanitize_body
    quiet = args.quiet
    inject_client = args.inject_client
    proxy_setting = "direct" if args.direct else args.proxy
    extra_headers = args.extra_header
    upstream_timeout = args.timeout
    sse_keepalive = args.keepalive
    verbose_log = args.verbose
    upstream_retries = args.retries

    server = ThreadingHTTPServer(("127.0.0.1", args.port), ZenProxyHandler)
    print(f"MAIN STARTED port={args.port} pid={os.getpid()}", file=sys.stderr, flush=True)
    scheme = "https" if upstream_ssl else "http"
    print(f"zen identity proxy on http://127.0.0.1:{args.port} -> {scheme}://{upstream_host}:{upstream_port}{upstream_prefix}")
    print(f"rewrite enabled: {rewrite_enabled}, rotation: {identity_mapper.rotation}s, body sanitize: {sanitize_body}")
    print(f"inject x-opencode-client when missing: {inject_client or '(disabled)'}")
    print(f"extra headers injected: {extra_headers or '(none)'}")
    print(f"rewritten headers: {sorted(DEFAULT_REWRITE_HEADERS)}")
    print(f"upstream read timeout: {upstream_timeout or 'none'}s, SSE keepalive: {sse_keepalive}s")
    print(f"upstream error logging: on (peer/TLS detail included), verbose per-request connection log: {verbose_log}")
    print(f"transient upstream error retries: {upstream_retries} (TLS alert / conn reset / early close)")
    proxy = _resolve_proxy()
    if proxy is None:
        print("upstream route: direct (no system proxy in use)")
    else:
        print(f"upstream route: via {'https' if proxy[2] else 'http'} proxy {proxy[0]}:{proxy[1]}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
