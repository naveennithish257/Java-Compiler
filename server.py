#!/usr/bin/env python3
"""
JavaForge - Java Compilation Backend
Uses the locally installed JDK to compile and run Java code.
Works locally and on Cloud Run.
"""
import json, subprocess, tempfile, os, re, sys
from http.server import HTTPServer, BaseHTTPRequestHandler

# Cloud Run injects PORT env var; default to 5050 locally
PORT = int(os.environ.get('PORT', 5050))
HOST = '0.0.0.0'  # Cloud Run requires binding to all interfaces

class JavaHandler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == '/health':
            self._json_response({'status': 'ok', 'jdk': self._jdk_version()})
        else:
            self._json_response({'error': 'Not found'}, 404)

    def do_POST(self):
        if self.path != '/execute':
            self._json_response({'error': 'Not found'}, 404)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body.decode('utf-8'))
        except Exception as e:
            self._json_response({'error': f'Bad request: {e}'}, 400)
            return

        code  = data.get('code', '')
        stdin = data.get('stdin', '')

        result = self._compile_and_run(code, stdin)
        self._json_response(result)

    # ─────────────────────────── core logic ───────────────────────────────

    def _compile_and_run(self, code, stdin):
        # Extract public class name (fallback: Main)
        m = re.search(r'public\s+class\s+(\w+)', code)
        class_name = m.group(1) if m else 'Main'

        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                java_file = os.path.join(tmpdir, f'{class_name}.java')
                with open(java_file, 'w', encoding='utf-8') as f:
                    f.write(code)

                # ── 1. Compile ──────────────────────────────────────────
                cp = subprocess.run(
                    ['javac', java_file],
                    capture_output=True, text=True, timeout=30,
                    cwd=tmpdir
                )
                if cp.returncode != 0:
                    return {
                        'stdout': '',
                        'stderr': self._clean_paths(cp.stderr, tmpdir),
                        'exitCode': cp.returncode
                    }

                # ── 2. Run ─────────────────────────────────────────────
                rp = subprocess.run(
                    ['java', '-cp', tmpdir, class_name],
                    input=stdin,
                    capture_output=True, text=True, timeout=30,
                    cwd=tmpdir
                )
                return {
                    'stdout': rp.stdout,
                    'stderr': self._clean_paths(rp.stderr, tmpdir),
                    'exitCode': rp.returncode
                }

        except subprocess.TimeoutExpired:
            return {'stdout': '', 'stderr': 'Execution timed out (30s limit)', 'exitCode': -1}
        except FileNotFoundError:
            return {'stdout': '', 'stderr': 'javac/java not found. Make sure JDK is installed and in PATH.', 'exitCode': -1}
        except Exception as e:
            return {'stdout': '', 'stderr': str(e), 'exitCode': -1}

    def _clean_paths(self, text, tmpdir):
        """Strip temp directory paths from compiler messages."""
        return text.replace(tmpdir + os.sep, '').replace(tmpdir + '/', '').replace(tmpdir, '')

    def _jdk_version(self):
        try:
            r = subprocess.run(['java', '-version'], capture_output=True, text=True, timeout=5)
            return (r.stdout or r.stderr).split('\n')[0].strip()
        except Exception:
            return 'unknown'

    # ─────────────────────────── helpers ──────────────────────────────────

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json_response(self, data, code=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self._cors()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Minimal logging: only print requests
        print(f'[JavaForge] {self.address_string()} - {fmt % args}')


# ──────────────────────────────── entry ───────────────────────────────────

if __name__ == '__main__':
    httpd = HTTPServer((HOST, PORT), JavaHandler)
    version = JavaHandler(None, None, None)._jdk_version() if False else ''
    try:
        r = subprocess.run(['java', '-version'], capture_output=True, text=True, timeout=5)
        version = (r.stdout or r.stderr).split('\n')[0].strip()
    except Exception:
        version = 'JDK not detected'

    print('=' * 46)
    print('   JavaForge -- Local Backend')
    print('=' * 46)
    print(f'  JDK  : {version[:42]}')
    print(f'  Port : http://127.0.0.1:{PORT}')
    print('  Press Ctrl+C to stop')
    print('=' * 46)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nServer stopped.')
        sys.exit(0)
