export interface ExistingSmsRecord {
  phone?: string | null;
  content?: string | null;
  received_at?: string | null;
  unread?: number | boolean | null;
  direction?: string | null;
  raw_json?: string | null;
}

export interface IncomingSmsRecord {
  phone: string;
  content: string;
  date: string | null;
  unread: boolean;
  direction: string;
}

/** 只有短信字段真的变化时才写回 SQLite，避免每轮同步制造无效 WAL 写入。 */
export function hasStoredSmsChanged(
  existing: ExistingSmsRecord,
  sms: IncomingSmsRecord,
  rawJson: string,
): boolean {
  return existing.phone !== sms.phone
    || existing.content !== sms.content
    || existing.received_at !== sms.date
    || Boolean(existing.unread) !== sms.unread
    || (existing.direction || 'inbound') !== sms.direction
    || (existing.raw_json || null) !== rawJson;
}
