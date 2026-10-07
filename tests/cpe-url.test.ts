import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCpeUrl } from '../src/lib/cpe-url.ts';

test('首次引导中的裸 IP 自动使用 HTTP，兼容主机名和端口', () => {
  assert.equal(normalizeCpeUrl('192.168.8.1'), 'http://192.168.8.1');
  assert.equal(normalizeCpeUrl(' 192.168.8.1:8080 '), 'http://192.168.8.1:8080');
  assert.equal(normalizeCpeUrl('router.local:8080'), 'http://router.local:8080');
  assert.equal(normalizeCpeUrl('[fd00::1]:8080'), 'http://[fd00::1]:8080');
});

test('显式 HTTPS 和自定义路径保留，移除页面查询参数和末尾斜杠', () => {
  assert.equal(normalizeCpeUrl('https://192.168.8.1:8443/'), 'https://192.168.8.1:8443');
  assert.equal(normalizeCpeUrl('http://router.local/cpe/?page=home#login'), 'http://router.local/cpe');
});

test('拒绝空地址、无效端口、非 HTTP 协议和地址内嵌凭据', () => {
  for (const value of ['', '  ', 'not a hostname', '192.168.8.1:99999', 'ftp://192.168.8.1']) {
    assert.throws(() => normalizeCpeUrl(value), Error, value);
  }
  assert.throws(() => normalizeCpeUrl('http://admin:secret@192.168.8.1'), /用户名和密码/);
});
