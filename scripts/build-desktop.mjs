import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const target = path.join(root, 'src-tauri', 'resources', 'server');
const staticDir = path.join(root, '.next', 'static');
const publicDir = path.join(root, 'public');
const nodeExe = process.platform === 'win32' ? process.env.CPE_NODE_RUNTIME : process.execPath;

if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  throw new Error('未找到 .next/standalone/server.js，请先运行 npm run build');
}

if (!nodeExe || !fs.existsSync(nodeExe)) {
  throw new Error('Windows 桌面构建需要 CPE_NODE_RUNTIME 指向匹配架构的 node.exe');
}
const runtime = JSON.parse(execFileSync(nodeExe, ['-p', 'JSON.stringify({ arch: process.arch, modules: process.versions.modules, version: process.version })'], { encoding: 'utf8' }));
if (runtime.modules !== process.versions.modules) {
  throw new Error(`Node 运行时 ABI 不匹配：构建环境 ${process.version}，内置运行时 ${runtime.version}`);
}
if (process.platform === 'win32' && runtime.arch !== 'x64') {
  throw new Error('Windows 安装包必须使用 x64 Node 运行时');
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(standalone, target, {
  recursive: true,
  // 安装包不得包含构建机的环境变量和密钥文件。
  filter: (source) => !/^\.env(?:\.|$)/.test(path.basename(source)),
});
fs.cpSync(staticDir, path.join(target, '.next', 'static'), { recursive: true });
fs.cpSync(publicDir, path.join(target, 'public'), { recursive: true });

// 用实际随安装包分发的运行时加载原生模块，提前发现漏包或 ABI 问题。
const databaseModule = path.join(target, 'node_modules', 'better-sqlite3');
const sqliteNativeBinary = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(sqliteNativeBinary)) {
  throw new Error('缺少 better-sqlite3 原生模块，请运行 npm rebuild better-sqlite3 后重新构建');
}
// 显式带上 SQLite 二进制，避免 Next.js 动态加载追踪漏掉原生绑定。
fs.mkdirSync(path.join(databaseModule, 'build', 'Release'), { recursive: true });
fs.copyFileSync(sqliteNativeBinary, path.join(databaseModule, 'build', 'Release', 'better_sqlite3.node'));
const sqliteCheck = `const Database = require(${JSON.stringify(databaseModule)}); const db = new Database(':memory:'); db.prepare('SELECT 1').get(); db.close();`;
execFileSync(nodeExe, ['-e', sqliteCheck], { stdio: 'inherit' });

if (process.platform === 'win32') {
  const binDir = path.join(root, 'src-tauri', 'binaries');
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(nodeExe, path.join(binDir, 'node-x86_64-pc-windows-msvc.exe'));
}

console.log(`桌面服务资源已准备并验证: ${target}`);
