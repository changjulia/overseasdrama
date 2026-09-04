import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from deploy.auth_service import Accounts, make_server


class AccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Accounts(Path(self.temp.name) / 'users.sqlite')
        self.admin = self.store.create('admin', '管理员', 'test-password-strong', 'admin')

    def tearDown(self):
        self.temp.cleanup()

    def test_registration_approval_password_and_disable(self):
        member = self.store.register('tester', '测试成员', 'member-password-strong', 'one')
        with self.assertRaisesRegex(ValueError, '账号尚未启用'):
            self.store.login('tester', 'member-password-strong', 'one')
        with self.assertRaisesRegex(ValueError, '账号或密码错误'):
            self.store.login('tester', 'wrong-password', 'one')
        with self.assertRaisesRegex(ValueError, '账号或密码错误'):
            self.store.login('unknown-user', 'member-password-strong', 'one')
        self.store.update(self.admin, member, {'active': True})
        token, ttl, user = self.store.login('tester', 'member-password-strong', 'one')
        self.assertEqual(user['role'], 'member')
        self.assertEqual(ttl, 43200)
        # Sessions survive a gateway restart without storing plaintext tokens.
        other = Accounts(self.store.path)
        self.assertEqual(other.user(token)['id'], member)
        with self.store.db() as db:
            self.assertNotEqual(db.execute('SELECT token FROM sessions').fetchone()[0], token)
        with self.assertRaises(PermissionError):
            self.store.update(member, self.admin, {'active': False})
        self.store.change_password(member, 'member-password-strong', 'updated-password-strong')
        self.assertIsNone(self.store.user(token))
        token, _, _ = self.store.login('tester', 'updated-password-strong', 'one')
        self.store.update(self.admin, member, {'active': False})
        self.assertIsNone(self.store.user(token))
        with self.assertRaises(ValueError):
            self.store.update(self.admin, self.admin, {'active': False})

    def test_rate_limit_logout_expiry(self):
        token, _, _ = self.store.login('admin', 'test-password-strong', 'ok')
        self.store.logout(token)
        self.assertIsNone(self.store.user(token))
        token, _, _ = self.store.login('admin', 'test-password-strong', 'ok')
        with self.store.db() as db:
            db.execute('UPDATE sessions SET expires=1')
        self.assertIsNone(self.store.user(token))
        for _ in range(20):
            with self.assertRaises(ValueError):
                self.store.login('admin', 'wrong', 'attacker')
        with self.assertRaises(PermissionError):
            self.store.login('admin', 'test-password-strong', 'attacker')

    def test_http_csrf_cookie_roles_and_registration_injection(self):
        server = make_server('127.0.0.1', 0, self.store.path, 'https://app.example')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f'http://127.0.0.1:{server.server_port}'

        def request(path, data=None, cookie='', origin='https://app.example'):
            headers = {'Origin': origin, 'Content-Type': 'application/json', 'Cookie': cookie}
            req = urllib.request.Request(base + path, None if data is None else json.dumps(data).encode(), headers)
            try:
                response = urllib.request.urlopen(req)
            except urllib.error.HTTPError as error:
                response = error
            return response.status, response.headers, json.loads(response.read())

        try:
            status, _, _ = request('/auth/register', {'username': 'new-user', 'name': 'New', 'password': 'password-for-new-user', 'role': 'admin', 'active': True})
            self.assertEqual(status, 201)
            with self.store.db() as db:
                row = db.execute("SELECT * FROM users WHERE username='new-user'").fetchone()
                self.assertEqual((row['role'], row['active']), ('member', 0))
            status, headers, payload = request('/auth/login', {'username': 'new-user', 'password': 'password-for-new-user'})
            self.assertEqual(status, 400)
            self.assertIn('账号尚未启用', payload['message'])
            self.assertIsNone(headers.get('Set-Cookie'))
            data = {'username': 'admin', 'password': 'test-password-strong'}
            self.assertEqual(request('/auth/login', data, origin='https://evil.example')[0], 403)
            status, headers, payload = request('/auth/login', data)
            self.assertEqual(status, 200)
            self.assertNotIn('password', payload['user'])
            cookie = headers['Set-Cookie']
            self.assertIn('HttpOnly', cookie)
            self.assertIn('Secure', cookie)
            self.assertEqual(request('/auth/users', cookie=cookie.split(';')[0])[0], 200)
            forged = urllib.request.Request(base + '/auth/verify', headers={'Cookie': cookie.split(';')[0], 'X-Forwarded-Method': 'POST', 'Origin': 'https://evil.example'})
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(forged)
            self.assertEqual(caught.exception.code, 403)
            self.assertEqual(request('/auth/users')[0], 401)
            self.assertEqual(request('/auth/logout', {}, cookie=cookie.split(';')[0])[0], 200)
            self.assertEqual(request('/auth/me', cookie=cookie.split(';')[0])[0], 401)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
