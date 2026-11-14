#!/usr/bin/env python3
"""A stand-in Docker engine on a Unix socket, for test/gjs-smoke.js.

Usage: fake-docker.py SOCKET_PATH
Answers the few endpoints Tacho uses, like the real engine does.
"""
import json
import os
import socketserver
import sys
from http.server import BaseHTTPRequestHandler

CONTAINERS = [
    {"Id": "aaa111", "Names": ["/web"], "Image": "nginx:1.27", "State": "running", "Status": "Up 2 hours"},
    {"Id": "bbb222", "Names": ["/db"], "Image": "postgres:17", "State": "exited", "Status": "Exited (0) 3 days ago"},
]


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "unix"

    def log_message(self, *args):
        pass

    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/containers/json"):
            self.reply(200, CONTAINERS)
        elif self.path == "/info":
            self.reply(200, {"MemTotal": 8 * 1024 ** 3})
        elif self.path.startswith("/containers/aaa111/stats"):
            self.reply(200, {"memory_stats": {"usage": 300 * 1024 ** 2, "stats": {"inactive_file": 100 * 1024 ** 2}}})
        else:
            self.reply(404, {"message": "not found"})

    def do_POST(self):
        for c in CONTAINERS:
            if self.path == f"/containers/{c['Id']}/start":
                c["State"] = "running"
                return self.reply(204)
            if self.path.startswith(f"/containers/{c['Id']}/stop"):
                c["State"] = "exited"
                return self.reply(204)
        self.reply(404, {"message": "no such container"})


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


path = sys.argv[1]
if os.path.exists(path):
    os.unlink(path)
with Server(path, Handler) as server:
    print("ready", flush=True)
    server.serve_forever()
