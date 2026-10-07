export function normalizeCpeUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('请填写 CPE 地址');

  let url: URL;
  try {
    url = new URL(input.includes('://') ? input : `http://${input}`);
  } catch {
    throw new Error('CPE 地址无效，请填写 IP 地址或 http/https 地址');
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('CPE 地址仅支持 http 或 https');
  }
  if (url.username || url.password) {
    throw new Error('请在用户名和密码输入框填写凭据，不要放在 CPE 地址中');
  }

  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}
