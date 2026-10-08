import assert from 'node:assert/strict';
import test from 'node:test';
import { CpeSmsReader } from '../src/lib/cpe-sms-reader.ts';
import type { CpeAuthenticator } from '../src/lib/cpe-authenticator.ts';
import type { SmsOverview } from '../src/lib/sms-lightweight-sync.ts';

const emptyXml = '<response><messages></messages></response>';
function messageXml(index = '1'): string {
  return `<message><phone>13800138000</phone><content>测试短信</content><date>2026-10-07 12:00:00</date><smstat>0</smstat><smstype>1</smstype><curbox>0</curbox><index>${index}</index></message>`;
}
const oneMessageXml = `<response><messages>${messageXml()}</messages></response>`;

function createReader(onPost: (path: string, body: string) => string, count = { LocalInbox: '1', LocalOutbox: '0' }) {
  const stats = { logins: 0, posts: [] as string[] };
  const auth = {
    async apiGet() { return count; },
    async relogin() { stats.logins += 1; return true; },
    getLastLoginError() { return '测试登录失败'; },
    async withRequestLock<T>(task: () => Promise<T>) { return task(); },
    async ensureLogin() { return true; },
    async refreshToken() {},
    rsaEncrypt(value: string) { return value; },
    async postWithSession(path: string, body: string) {
      stats.posts.push(path);
      return { status: 200, text: onPost(path, body), sessionId: 'test-session' };
    },
    persistSession() {},
  };
  const reader = new CpeSmsReader(auth as unknown as CpeAuthenticator);
  const overview: SmsOverview = { count, contacts: reader.parseSmsMessages(oneMessageXml) };
  return { reader, stats, overview };
}

test('完整读取复用计数和联系人摘要，不重复请求', async () => {
  const h = createReader(() => oneMessageXml);
  const result = await h.reader.getSmsMessages(h.overview);
  assert.equal(result.messages.length, 1);
  assert.deepEqual(h.stats.posts, ['/api/sms/sms-list-phone']);
});

test('短信 XML 错误、空响应和非短信响应明确失败', async () => {
  for (const response of ['<error><code>100002</code></error>', '', '<html>unexpected</html>']) {
    const h = createReader(() => response);
    await assert.rejects(h.reader.getSmsOverview());
    assert.equal(h.stats.logins, 0);
  }
});

test('正计数但联系人或正文为空，重新登录后仍为空则失败', async () => {
  const noContacts = createReader(() => emptyXml);
  await assert.rejects(noContacts.reader.getSmsOverview(), /未返回联系人/);
  assert.equal(noContacts.stats.logins, 1);
  const noBody = createReader((path) => path.endsWith('sms-list-contact') ? oneMessageXml : emptyXml);
  await assert.rejects(noBody.reader.getSmsMessages(noBody.overview), /未返回短信正文/);
  assert.equal(noBody.stats.logins, 1);
});

test('真实零计数和空列表能完成初始快照', async () => {
  const h = createReader(() => emptyXml, { LocalInbox: '0', LocalOutbox: '0' });
  const result = await h.reader.getSmsMessages();
  assert.deepEqual(result.messages, []);
  assert.equal(h.stats.logins, 0);
});

test('联系人或号码历史达到满页上限时不得登记为完整快照', async () => {
  const fullPage = `<response><messages>${Array.from({ length: 50 }, (_, index) => messageXml(String(index))).join('')}</messages></response>`;
  const contacts = createReader(() => fullPage);
  await assert.rejects(contacts.reader.getSmsOverview(), /联系人超过读取上限/);
  assert.equal(contacts.stats.posts.length, 20);
  const history = createReader(() => fullPage);
  await assert.rejects(history.reader.getSmsMessages(history.overview), /历史超过读取上限/);
  assert.equal(history.stats.posts.length, 20);
});

test('一个号码读取失败时整轮失败，不返回部分成功快照', async () => {
  for (const failedResponse of ['<error><code>100002</code></error>', emptyXml]) {
    let reads = 0;
    const h = createReader(() => ++reads === 1 ? oneMessageXml : failedResponse);
    h.overview.contacts.push({ ...h.overview.contacts[0], id: '2', phone: '13900139000' });
    await assert.rejects(h.reader.getSmsMessages(h.overview));
    assert.equal(reads, 2);
  }
});
