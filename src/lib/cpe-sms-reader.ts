/**
 * CpeSmsReader — handles SMS message retrieval and parsing from CPE device.
 *
 * Extracted from CpeClient to enforce Single Responsibility Principle.
 */
import { extractXmlTag, isCpeAuthenticationFailure } from './cpe-protocol.ts';
import { buildXmlRequest } from './cpe-protocol.ts';
import { decryptSmsEnvelope, generateHexNonce } from './cpe-crypto.ts';
import type { CpeAuthenticator } from './cpe-authenticator';
import type { CpeSmsMessage } from '@/types/cpe';
import { parseCpeRecord } from './cpe-protocol.ts';
import { getExpectedLocalSmsCount, validateSmsCount, type SmsOverview } from './sms-lightweight-sync.ts';

const SMS_PAGE_SIZE = 50;
const SMS_MAX_PAGES = 20;

export class CpeSmsReader {
  private auth: CpeAuthenticator;

  constructor(auth: CpeAuthenticator) {
    this.auth = auth;
  }

  async getSmsCount(): Promise<Record<string, string>> {
    const count = parseCpeRecord(await this.auth.apiGet('/api/sms/sms-count'));
    validateSmsCount(count);
    return count;
  }

  async getSmsOverview(): Promise<SmsOverview> {
    const readOverview = async () => {
      const count = await this.getSmsCount();
      const contacts = await this.fetchContactMessages();
      return { count, contacts };
    };
    let overview = await readOverview();
    if (getExpectedLocalSmsCount(overview.count) > 0 && overview.contacts.length === 0) {
      const ok = await this.auth.relogin();
      if (!ok) throw new Error(this.auth.getLastLoginError());
      overview = await readOverview();
      if (getExpectedLocalSmsCount(overview.count) > 0 && overview.contacts.length === 0) {
        throw new Error('CPE 有短信，但未返回联系人列表，请稍后重试。');
      }
    }
    return overview;
  }

  async getSmsMessages(overview?: SmsOverview): Promise<{ messages: CpeSmsMessage[]; count: Record<string, string> }> {
    const readSnapshot = async (snapshot: SmsOverview) => {
      const { count, contacts } = snapshot;
      const messages = await this.fetchPhoneMessages(contacts);

      const unique = new Map<string, CpeSmsMessage>();
      for (const message of messages) unique.set(`${message.box}|${message.id}`, message);
      return {
        messages: [...unique.values()].sort((a, b) => b.date.localeCompare(a.date)),
        count,
      };
    };

    let result = await readSnapshot(overview || await this.getSmsOverview());
    if (getExpectedLocalSmsCount(result.count) > 0 && result.messages.length === 0) {
      const ok = await this.auth.relogin();
      if (!ok) throw new Error(this.auth.getLastLoginError());
      result = await readSnapshot(await this.getSmsOverview());
      if (getExpectedLocalSmsCount(result.count) > 0 && result.messages.length === 0) {
        throw new Error('CPE 有短信，但未返回短信正文，请稍后重试。');
      }
    }
    return result;
  }

  parseSmsMessages(xml: string): CpeSmsMessage[] {
    if (/<error[\s>]/i.test(xml)) throw new Error('CPE 短信接口返回错误，请稍后重试。');
    if (!xml) throw new Error('CPE 短信接口返回空响应，请稍后重试。');
    if (!/<(?:response|messages)[\s>]/i.test(xml)) throw new Error('CPE 短信接口响应格式异常，请稍后重试。');
    const messages: CpeSmsMessage[] = [];
    const blocks = xml.matchAll(/<message>([\s\S]*?)<\/message>/gi);
    for (const block of blocks) {
      const item = block[1];
      const phone = extractXmlTag(item, 'phone');
      const content = extractXmlTag(item, 'content');
      const date = extractXmlTag(item, 'date');
      const status = extractXmlTag(item, 'smstat');
      const type = extractXmlTag(item, 'smstype');
      const box = extractXmlTag(item, 'curbox');
      const index = extractXmlTag(item, 'index');
      if (!phone && !content && !date) continue;
      messages.push({
        id: index || `${phone}|${date}|${content}`,
        phone: phone || '-',
        content,
        date,
        status,
        type,
        box,
        unread: status === '0',
        direction: box === '0' ? 'inbound' : 'outbound',
      });
    }
    return messages;
  }

  private async fetchContactMessages(): Promise<CpeSmsMessage[]> {
    const contacts: CpeSmsMessage[] = [];
    for (let page = 1; page <= SMS_MAX_PAGES; page += 1) {
      const xml = await this.apiPostEncrypted('/api/sms/sms-list-contact', {
        pageindex: page,
        readcount: SMS_PAGE_SIZE,
      });
      const pageMessages = this.parseSmsMessages(xml);
      if (pageMessages.length === 0) break;
      contacts.push(...pageMessages);
      if (pageMessages.length < SMS_PAGE_SIZE) break;
      if (page === SMS_MAX_PAGES) {
        throw new Error('CPE 短信联系人超过读取上限，本次同步未完成。');
      }
    }
    return contacts;
  }

  private async fetchPhoneMessages(contacts: CpeSmsMessage[]): Promise<CpeSmsMessage[]> {
    const phoneNumbers = [...new Set(contacts.map((m) => m.phone).filter(Boolean))];
    const messages: CpeSmsMessage[] = [];
    let emptyPhones = 0;
    for (const phone of phoneNumbers) {
      for (let page = 1; page <= SMS_MAX_PAGES; page += 1) {
        const xml = await this.apiPostEncrypted('/api/sms/sms-list-phone', {
          phone,
          pageindex: page,
          readcount: SMS_PAGE_SIZE,
        }, true);
        const pageMessages = this.parseSmsMessages(xml);
        if (pageMessages.length === 0) {
          if (page === 1) emptyPhones += 1;
          break;
        }
        messages.push(...pageMessages);
        if (pageMessages.length < SMS_PAGE_SIZE) break;
        if (page === SMS_MAX_PAGES) {
          throw new Error('CPE 短信历史超过读取上限，本次同步未完成。');
        }
      }
    }
    if (emptyPhones > 0 && messages.length > 0) {
      throw new Error('部分 CPE 联系人未返回短信正文，本次同步未完成。');
    }
    return messages;
  }

  private async apiPostEncrypted(
    path: string,
    data: Record<string, string | number>,
    encryptPhone = false,
    retry = true,
  ): Promise<string> {
    const encryptedAttempt = await this.auth.withRequestLock(async () => {
      await this.auth.ensureLogin();
      await this.auth.refreshToken();

      const firstNonce = generateHexNonce();
      const secondNonce = generateHexNonce();
      const requestData: Record<string, string | number> = {
        ...data,
        nonce: this.auth.rsaEncrypt(firstNonce + secondNonce),
        hmac_len: 32,
      };
      if (encryptPhone && typeof requestData.phone === 'string') {
        requestData.phone = this.auth.rsaEncrypt(requestData.phone);
      }
      const requestXml = buildXmlRequest(requestData);
      const result = await this.auth.postWithSession(
        path,
        requestXml,
        encryptPhone
          ? 'application/x-www-form-urlencoded; charset=UTF-8;enp'
          : 'application/x-www-form-urlencoded; charset=UTF-8',
      );
      return { result, firstNonce, secondNonce };
    });

    const { result, firstNonce, secondNonce } = encryptedAttempt;
    if (retry && isCpeAuthenticationFailure(result.status, result.text)) {
      const ok = await this.auth.relogin(result.sessionId);
      if (!ok) throw new Error(this.auth.getLastLoginError());
      return this.apiPostEncrypted(path, data, encryptPhone, false);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`API request failed: ${result.status}`);
    }

    const xml = result.text;
    if (/<error[\s>]/i.test(xml)) throw new Error('CPE 短信接口返回错误，请稍后重试。');
    this.auth.persistSession();

    const encrypted = extractXmlTag(xml, 'pwd');
    const hash = extractXmlTag(xml, 'hash');
    const iterations = Number(extractXmlTag(xml, 'iter'));
    if (!encrypted || !hash || !iterations) return xml;

    return decryptSmsEnvelope({
      encryptedHex: encrypted,
      expectedHash: hash,
      iterations,
      firstNonce,
      secondNonce,
    });
  }
}
