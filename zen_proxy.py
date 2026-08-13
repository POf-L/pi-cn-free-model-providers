"""OpenCode Zen 会话标识替换代理

opencode 客户端 -> 本代理(替换会话标识, 周期性轮换) -> https://opencode.ai/zen/v1

策略:
    - 识别现有会话标识头, 用假标识替换, 不剥离
    - 同一真实会话在轮换周期内保持同一个假标识(可关联但非真实)
    - 默认每 600 秒(10 分钟)轮换一次, 全映射重建, 假标识全部更换
    - 多会话独立: 每个真实会话 id 映射到各自不同的假 id
    - 请求级 id(x-opencode-request 等)每次请求随机生成
    - 保留 x-opencode-client, 避免 Zen 将请求识别为匿名客户端而被限流

用法:
    python zen_proxy.py --port 8643 [--rotation 600]
    opencode.jsonc 中 opencode(Zen) provider baseURL 指向 http://127.0.0.1:8643/v1
    上游默认自动走系统/环境代理(Windows 注册表 + HTTP(S)_PROXY), --direct 强制直连,
    --proxy http(s)://host:port 可显式指定代理。

SSE 流式响应实时透传。
"""

import argparse
import base64
import json
import os
import random
import ssl
import string
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.client import HTTPConnection, HTTPSConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOP_HEADERS = {
    "host", "connection", "transfer-encoding", "content-length",
    "accept-encoding", "expect", "keep-alive", "proxy-connection", "upgrade",
}

DEFAULT_REWRITE_HEADERS = {
    "x-opencode-session": "ses_",
    "x-session-id": "ses_",
    "x-parent-session-id": "ses_",
    "x-opencode-project": "proj_",
    "x-opencode-request": "req_",
    "x-opencode-request-id": "req_",
    "x-request-id": "req_",
}


class IdentityMapper:
    def __init__(self, rotation):
        self.rotation = rotation
        self.lock = threading.Lock()
        self.epoch = 0
        self.map = {}

    def _current_epoch(self):
        if self.rotation <= 0:
            return 0
        return int(time.time() // self.rotation)

    def fake(self, real, prefix):
        if not real:
            return real
        with self.lock:
            epoch = self._current_epoch()
            if epoch != self.epoch:
                self.epoch = epoch
                self.map = {}
            fake = self.map.get(real)
            if fake is None:
                fake = prefix + "".join(random.choices(string.ascii_letters + string.digits, k=22))
                self.map[real] = fake
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
        if path.startswith("/v1"):
            path = path[3:]
        upstream_path = upstream_prefix + path
        if split.query:
            upstream_path += "?" + split.query

        headers = {}
        for key, value in self.headers.items():
            lkey = key.lower()
            if lkey in HOP_HEADERS or lkey in strip_headers:
                continue
            if rewrite_enabled and lkey in DEFAULT_REWRITE_HEADERS:
                prefix = DEFAULT_REWRITE_HEADERS[lkey]
                if prefix == "req_":
                    value = identity_mapper.random_id(prefix)
                else:
                    value = identity_mapper.fake(value, prefix)
            headers[key] = value

        if inject_client and "x-opencode-client" not in headers:
            headers["x-opencode-client"] = inject_client

        if not quiet:
            self._log_request(headers, upstream_path)

        if body and sanitize_body:
            try:
                obj = json.loads(body)
            except ValueError:
                obj = None
            if isinstance(obj, dict):
                obj.pop("user", None)
                obj.pop("metadata", None)
                body = json.dumps(obj).encode()

        conn = _upstream_connection()
        try:
            if os.environ.get("ZEN_PROXY_DEBUG"):
                print(f"[debug] OUT {self.command} {upstream_path} headers={headers!r}", file=sys.stderr, flush=True)
            conn.request(self.command, upstream_path, body=body if body else None, headers=headers)
        except OSError as e:
            return self._send_json(502, {"error": f"cannot reach upstream: {e}"})

        resp = conn.getresponse()
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
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self._write_chunk(chunk)
            self._write_chunk(b"")
        else:
            resp_body = resp.read()
            self.send_header("Content-Length", str(len(resp_body)))
            self.end_headers()
            self.wfile.write(resp_body)
        conn.close()

    def _write_chunk(self, data):
        if data:
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
        else:
            self.wfile.write(b"0\r\n\r\n")

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
    timeout = 600
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
    parser = argparse.ArgumentParser(description="OpenCode Zen session identity rotation proxy")
    parser.add_argument("--port", type=int, default=8643)
    parser.add_argument("--upstream-host", default="opencode.ai")
    parser.add_argument("--upstream-port", type=int, default=443)
    parser.add_argument("--upstream-prefix", default="/zen/v1")
    parser.add_argument("--no-ssl", action="store_true")
    parser.add_argument("--rotation", type=int, default=600,
                        help="seconds between fake identity rotation (0 = never)")
    parser.add_argument("--no-rewrite", action="store_true",
                        help="pass session identifying headers through unchanged")
    parser.add_argument("--strip", action="append", default=[],
                        help="additional header names to remove entirely (lowercase)")
    parser.add_argument("--no-sanitize-body", action="store_true",
                        help="do not remove user/metadata from request body")
    parser.add_argument("--quiet", action="store_true",
                        help="do not log per-request lines")
    parser.add_argument("--inject-client", default="cli",
                        help="x-opencode-client value to inject when missing (empty = disable)")
    parser.add_argument("--proxy", default="",
                        help="upstream proxy: 留空=自动检测系统/环境代理, 'direct'=强制直连, 或 http(s)://host:port 显式指定")
    parser.add_argument("--direct", action="store_true",
                        help="force direct connection, ignore system proxy")
    args = parser.parse_args()

    global upstream_host, upstream_port, upstream_prefix, upstream_ssl
    global identity_mapper, rewrite_enabled, strip_headers, sanitize_body, quiet, inject_client, proxy_setting
    upstream_host = args.upstream_host
    upstream_port = args.upstream_port
    upstream_prefix = args.upstream_prefix
    upstream_ssl = not args.no_ssl
    identity_mapper = IdentityMapper(args.rotation)
    rewrite_enabled = not args.no_rewrite
    strip_headers = set(args.strip)
    sanitize_body = not args.no_sanitize_body
    quiet = args.quiet
    inject_client = args.inject_client
    proxy_setting = "direct" if args.direct else args.proxy

    server = ThreadingHTTPServer(("127.0.0.1", args.port), ZenProxyHandler)
    print(f"MAIN STARTED port={args.port} pid={os.getpid()}", file=sys.stderr, flush=True)
    scheme = "https" if upstream_ssl else "http"
    print(f"zen identity proxy on http://127.0.0.1:{args.port} -> {scheme}://{upstream_host}:{upstream_port}{upstream_prefix}")
    print(f"rewrite enabled: {rewrite_enabled}, rotation: {args.rotation}s, body sanitize: {sanitize_body}")
    print(f"inject x-opencode-client when missing: {inject_client or '(disabled)'}")
    print(f"rewritten headers: {sorted(DEFAULT_REWRITE_HEADERS)}")
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
