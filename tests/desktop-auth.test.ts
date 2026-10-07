import assert from 'node:assert/strict';
import test from 'node:test';
import { isDesktopMode, isLocalDesktopRequest } from '../src/lib/desktop-auth.ts';

const desktop = { CPE_DESKTOP_MODE: 'true', HOSTNAME: '127.0.0.1', PORT: '3210' };

test('免密码只对显式启用并绑定本机的桌面服务生效', () => {
  assert.equal(isDesktopMode(desktop), true);
  assert.equal(isDesktopMode({ ...desktop, CPE_DESKTOP_MODE: 'false' }), false);
  assert.equal(isDesktopMode({ ...desktop, HOSTNAME: '0.0.0.0' }), false);
  assert.equal(isDesktopMode({}), false);
});

test('本机桌面可无 Cookie 请求，端口与同源请求保持一致', () => {
  assert.equal(isLocalDesktopRequest(new Headers({ host: '127.0.0.1:3210' }), desktop), true);
  assert.equal(isLocalDesktopRequest(new Headers({
    host: 'localhost:3210', origin: 'http://localhost:3210', 'sec-fetch-site': 'same-origin',
  }), desktop), true);
  assert.equal(isLocalDesktopRequest(new Headers({ host: '127.0.0.1:3211' }), { ...desktop, PORT: '3211' }), true);
  assert.equal(isLocalDesktopRequest(new Headers({ host: '127.0.0.1:3211' }), desktop), false);
});

test('免密码拒绝远程 Host、异源网页及跨站请求', () => {
  const requests: Record<string, string>[] = [
    { host: 'evil.example:3210' },
    { host: '192.168.8.2:3210' },
    { host: '127.0.0.1:3210', origin: 'https://evil.example' },
    { host: '127.0.0.1:3210', origin: 'null' },
    { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3211' },
    { host: '127.0.0.1:3210', 'sec-fetch-site': 'cross-site' },
  ];
  for (const headers of requests) {
    assert.equal(isLocalDesktopRequest(new Headers(headers), desktop), false);
  }
  assert.equal(isLocalDesktopRequest(new Headers(), desktop), false);
  assert.equal(isLocalDesktopRequest(new Headers({ host: '127.0.0.1:3210' }), {}), false);
});
