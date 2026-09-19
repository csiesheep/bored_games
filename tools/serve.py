# -*- coding: utf-8 -*-
"""開發用的靜態伺服器（launch.json 指這支）。python -m http.server 不送 Cache-Control，
瀏覽器會把 ES module 快取住——改了檔案、重新整理、甚至開新分頁都還是舊的。"""
import sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1])
    root = sys.argv[2]
    handler = functools.partial(NoCache, directory=root)
    ThreadingHTTPServer(('127.0.0.1', port), handler).serve_forever()
