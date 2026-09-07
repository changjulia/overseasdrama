"""Small persistent account gateway. Expose only through Caddy, never directly."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlsplit

COOKIE = 'lumina_session'
KDF_LIMIT = threading.Semaphore(3)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    with KDF_LIMIT:
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return salt + ':' + digest


def password_valid(password):
    if not isinstance(password, str) or not 6 <= len(password) <= 128:
        raise ValueError('密码须为 6–128 个字符')
    return password


def public_user(row):
    return {key: row[key] for key in ('id', 'username', 'name', 'role', 'active')}


def validated_account(username, name, password, role):
    username = str(username).strip().lower()
    name = str(name).strip()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_.@-]{2,63}', username):
        raise ValueError('账号为 3–64 位字母、数字或 _.@-')
    if not name or len(name) > 60 or role not in ('admin', 'member'):
        raise ValueError('姓名或角色无效')
    return username, name, password_hash(password_valid(password)), role


class Accounts:
    def __init__(self, path, allow_first_admin=False):
        self.path = Path(path)
        self.allow_first_admin = allow_first_admin
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                  name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS attempts(ip TEXT NOT NULL, username TEXT NOT NULL, created INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE INDEX IF NOT EXISTS attempts_time ON attempts(created);
                CREATE TABLE IF NOT EXISTS registrations(ip TEXT NOT NULL, created INTEGER NOT NULL);
            ''')
        self.path.chmod(0o600)
        self.dummy_hash = password_hash(secrets.token_urlsafe(32))

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def create(self, username, name, password, role='member', active=True, actor=None):
        username, name, encoded, role = validated_account(username, name, password, role)
        user_id = secrets.token_hex(12)
        try:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                if actor:
                    admin = db.execute('SELECT * FROM users WHERE id=?', (actor,)).fetchone()
                    if not admin or not admin['active'] or admin['role'] != 'admin':
                        raise PermissionError('仅管理员可以管理账号')
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)', (user_id, username, name, encoded, role, int(active)))
        except sqlite3.IntegrityError:
            raise ValueError('该账号已存在') from None
        return user_id

    def register(self, username, name, password, ip):
        now = int(time.time())
        username, name, encoded, _ = validated_account(username, name, password, 'member')
        user_id = secrets.token_hex(12)
        try:
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                db.execute('DELETE FROM registrations WHERE created<?', (now - 3600,))
                if db.execute('SELECT count(*) FROM registrations WHERE ip=?', (ip,)).fetchone()[0] >= 5:
                    raise PermissionError('注册尝试过于频繁，请稍后再试')
                db.execute('INSERT INTO registrations VALUES(?,?)', (ip, now))
                first_account = self.allow_first_admin and db.execute('SELECT count(*) FROM users').fetchone()[0] == 0
                role = 'admin' if first_account else 'member'
                active = 1 if first_account else 0
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,?)', (user_id, username, name, encoded, role, active))
        except sqlite3.IntegrityError:
            raise ValueError('该账号已存在') from None
        return user_id

    def login(self, username, password, ip, remember=False):
        username = str(username).strip().lower()[:64]
        if not isinstance(password, str) or len(password) > 128:
            raise ValueError('账号或密码错误')
        now = int(time.time())
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM attempts WHERE created < ?', (now - 900,))
            db.execute('DELETE FROM sessions WHERE expires <= ?', (now,))
            ip_count = db.execute('SELECT count(*) FROM attempts WHERE ip=?', (ip,)).fetchone()[0]
            user_count = db.execute('SELECT count(*) FROM attempts WHERE username=?', (username,)).fetchone()[0]
            if ip_count >= 20 or user_count >= 30:
                raise PermissionError('尝试过于频繁，请 15 分钟后再试')
            db.execute('INSERT INTO attempts VALUES(?,?,?)', (ip, username, now))
            user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        encoded = user['password'] if user else self.dummy_hash
        valid = hmac.compare_digest(password_hash(password, encoded.split(':')[0]), encoded)
        if not user or not valid:
            raise ValueError('账号或密码错误')
        if not user['active']:
            raise ValueError('账号尚未启用，请联系管理员审核或启用后再登录')
        token = secrets.token_urlsafe(32)
        ttl = 7 * 86400 if remember else 12 * 3600
        with self.db() as db:
            # Password resets and account suspension may race a password check.
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
            if not current or current['password'] != encoded:
                raise ValueError('账号或密码错误')
            if not current['active']:
                raise ValueError('账号尚未启用，请联系管理员审核或启用后再登录')
            db.execute('INSERT INTO sessions VALUES(?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), user['id'], now + ttl))
            db.execute('DELETE FROM attempts WHERE ip=? AND username=?', (ip, username))
        return token, ttl, public_user(current)

    def user(self, token):
        if not token or len(token) > 128:
            return None
        with self.db() as db:
            row = db.execute('SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1',
                             (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()
        return public_user(row) if row else None

    def logout(self, token):
        with self.db() as db:
            db.execute('DELETE FROM sessions WHERE token=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def update(self, actor, target, data):
        encoded = password_hash(password_valid(data['password'])) if 'password' in data else None
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            # Recheck privileges inside the transaction, including concurrent demotions.
            admin = db.execute('SELECT * FROM users WHERE id=?', (actor,)).fetchone()
            if not admin or not admin['active'] or admin['role'] != 'admin':
                raise PermissionError('仅管理员可以管理账号')
            user = db.execute('SELECT * FROM users WHERE id=?', (target,)).fetchone()
            if not user:
                raise ValueError('账号不存在')
            role = data.get('role', user['role'])
            active = data.get('active', bool(user['active']))
            name = str(data.get('name', user['name'])).strip()
            if role not in ('admin', 'member') or not isinstance(active, bool) or not name or len(name) > 60:
                raise ValueError('账号设置无效')
            if user['active'] and user['role'] == 'admin' and (not active or role != 'admin'):
                if db.execute("SELECT count(*) FROM users WHERE role='admin' AND active=1").fetchone()[0] <= 1:
                    raise ValueError('必须保留至少一名启用的管理员')
            db.execute('UPDATE users SET name=?,role=?,active=?,password=? WHERE id=?', (name, role, int(active), encoded or user['password'], target))
            db.execute('DELETE FROM sessions WHERE user_id=?', (target,))

    def change_password(self, user_id, current, new):
        password_valid(new)
        if not isinstance(current, str) or len(current) > 128:
            raise ValueError('当前密码错误')
        with self.db() as db:
            row = db.execute('SELECT password FROM users WHERE id=?', (user_id,)).fetchone()
        if not row or not hmac.compare_digest(password_hash(current, row[0].split(':')[0]), row[0]):
            raise ValueError('当前密码错误')
        encoded = password_hash(new)
        with self.db() as db:
            result = db.execute('UPDATE users SET password=? WHERE id=? AND password=?', (encoded, user_id, row[0]))
            if not result.rowcount:
                raise ValueError('密码已变更，请重新登录')
            db.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))


class Handler(BaseHTTPRequestHandler):
    server_version = 'Lumina'

    def reply(self, status, data=None, extra=None, html=False):
        payload = data.encode() if html else json.dumps(data or {}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        if html:
            self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def cookie(self, token='', ttl=0):
        secure = '; Secure' if self.server.secure else ''
        return f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={ttl}{secure}'

    def token(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            return cookie[COOKIE].value if COOKIE in cookie else ''
        except Exception:
            return ''

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ('/login', '/register', '/account'):
            return self.reply(200, (Path(__file__).parent / 'auth_ui.html').read_text(encoding='utf-8'), html=True)
        if path in ('/auth/ui.js', '/auth/ui.css'):
            data = (Path(__file__).parent / ('auth_ui.js' if path.endswith('.js') else 'auth_ui.css')).read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == '/health':
            return self.reply(200, {'status': 'ok'})
        if path == '/auth/verify' and self.headers.get('X-Forwarded-Method', 'GET') not in ('GET', 'HEAD', 'OPTIONS'):
            if self.headers.get('Origin') != self.server.origin or self.headers.get('Sec-Fetch-Site', 'same-origin') != 'same-origin':
                return self.reply(403, {'message': '不允许跨站请求'})
        user = self.server.accounts.user(self.token())
        if not user:
            original = self.headers.get('X-Forwarded-Uri', '/')
            if path == '/auth/verify' and 'text/html' in self.headers.get('Accept', ''):
                safe = original if original.startswith('/') and not original.startswith('//') and '\\' not in original and '\r' not in original and '\n' not in original else '/'
                return self.reply(302, extra={'Location': '/login?return_to=' + quote(safe, safe='')})
            return self.reply(401, {'message': '请先登录'})
        if path == '/auth/verify':
            return self.reply(200, extra={'X-Lumina-Account-Id': user['id'], 'X-Lumina-Account-Name': quote(user['name'], safe=''), 'X-Lumina-Account-Email': user['username'] + '@lumina.internal'})
        if path == '/auth/me':
            return self.reply(200, {'user': user})
        if path == '/auth/users':
            if user['role'] != 'admin':
                return self.reply(403, {'message': '仅管理员可以管理账号'})
            with self.server.accounts.db() as db:
                users = [public_user(row) for row in db.execute('SELECT * FROM users ORDER BY username')]
            return self.reply(200, {'users': users})
        self.reply(404)

    def do_POST(self):
        try:
            if self.headers.get('Origin') != self.server.origin or self.headers.get('Sec-Fetch-Site', 'same-origin') != 'same-origin':
                return self.reply(403, {'message': '不允许跨站请求'})
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 16384 or not self.headers.get('Content-Type', '').startswith('application/json'):
                return self.reply(400, {'message': '请求格式无效'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                return self.reply(400, {'message': '请求格式无效'})
            path = urlsplit(self.path).path
            accounts = self.server.accounts
            if path == '/auth/register':
                created_id = accounts.register(data.get('username', ''), data.get('name', ''), data.get('password'), self.headers.get('X-Real-IP', self.client_address[0]))
                with accounts.db() as db:
                    created = db.execute('SELECT active FROM users WHERE id=?', (created_id,)).fetchone()
                active = bool(created['active'])
                message = '首个账号已创建为管理员，现在可以登录' if active else '注册成功，请等待管理员启用账号后登录'
                return self.reply(201, {'message': message, 'active': active})
            if path == '/auth/login':
                # Caddy replaces this header with the actual client address.
                ip = self.headers.get('X-Real-IP', self.client_address[0])
                token, ttl, user = accounts.login(data.get('username', ''), data.get('password', ''), ip, data.get('remember') is True)
                return self.reply(200, {'user': user}, {'Set-Cookie': self.cookie(token, ttl)})
            if path == '/auth/logout':
                accounts.logout(self.token())
                return self.reply(200, {'ok': True}, {'Set-Cookie': self.cookie()})
            user = accounts.user(self.token())
            if not user:
                return self.reply(401, {'message': '请先登录'})
            if path == '/auth/password':
                accounts.change_password(user['id'], data.get('currentPassword'), data.get('password'))
                return self.reply(200, {'ok': True}, {'Set-Cookie': self.cookie()})
            if user['role'] != 'admin':
                return self.reply(403, {'message': '仅管理员可以管理账号'})
            if path == '/auth/users':
                user_id = accounts.create(data.get('username', ''), data.get('name', ''), data.get('password'), data.get('role', 'member'), actor=user['id'])
                return self.reply(201, {'id': user_id})
            match = re.fullmatch(r'/auth/users/([a-f0-9]{24})', path)
            if match:
                accounts.update(user['id'], match[1], data)
                return self.reply(200, {'ok': True})
            self.reply(404)
        except PermissionError as error:
            self.reply(429 if '频繁' in str(error) else 403, {'message': str(error)})
        except ValueError as error:
            message = str(error) if not isinstance(error, json.JSONDecodeError) else '请求格式无效'
            self.reply(400, {'message': message})
        except TypeError:
            self.reply(400, {'message': '账号、密码或填写内容无效，请检查后重试'})
        except Exception:
            self.reply(503, {'message': '账号服务暂不可用，请稍后再试'})

    def log_message(self, *_args):
        pass


def make_server(host, port, db_path, origin, secure=True, allow_first_admin=False):
    server = ThreadingHTTPServer((host, port), Handler)
    server.accounts = Accounts(db_path, allow_first_admin=allow_first_admin)
    server.origin = origin.rstrip('/')
    server.secure = secure
    return server


if __name__ == '__main__':
    os.umask(0o077)
    server = make_server(
        os.environ.get('AUTH_HOST', '0.0.0.0'),
        int(os.environ.get('AUTH_PORT', '8080')),
        os.environ.get('AUTH_DB', '/data/accounts.sqlite'),
        os.environ['AUTH_ORIGIN'],
        secure=os.environ.get('AUTH_SECURE', '1') != '0',
        allow_first_admin=os.environ.get('AUTH_ALLOW_FIRST_ADMIN', '0') == '1',
    )
    bootstrap = Path(os.environ.get('AUTH_BOOTSTRAP', '/data/bootstrap.json'))
    if bootstrap.exists():
        data = json.loads(bootstrap.read_text())
        with server.accounts.db() as db:
            empty = db.execute('SELECT count(*) FROM users').fetchone()[0] == 0
        if empty:
            server.accounts.create(data['username'], data['name'], data['password'], 'admin')
        bootstrap.unlink()
    server.serve_forever()
