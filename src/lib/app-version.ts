import packageInfo from '../../package.json';

/**
 * 应用版本号的唯一来源。
 *
 * 之前 /api/system/health 返回的是硬编码的 '1.0.0'，桌面宿主里还写死过 '0.3.15'，
 * 都随版本发布过期，排查时反而误导。这里直接读 package.json，构建时就被内联。
 */
export const APP_VERSION = (packageInfo as { version?: string }).version ?? 'unknown';
