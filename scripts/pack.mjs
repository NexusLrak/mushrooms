// 把页面运行所需的最小文件集提取到 dist/，可直接上传到任何静态服务器。
// 用法：node scripts/pack.mjs        （只生成 dist/）
//       node scripts/pack.mjs --tar  （另外打成 mushrooms-site.tar.gz）
// 图片只复制 data/mushrooms.js 实际引用的，images/ 里的无关文件不会带上。
import { readFile, mkdir, rm, copyFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ARCHIVE = 'mushrooms-site.tar.gz';
// CREDITS.md 页面用不到，但图片的 CC 许可要求署名，公开部署时一起带上
const PAGE_FILES = ['index.html', 'style.css', 'app.js', 'data/mushrooms.js', 'CREDITS.md'];

const js = await readFile(join(ROOT, 'data/mushrooms.js'), 'utf8');
const data = JSON.parse(js.slice(js.indexOf('['), js.lastIndexOf(']') + 1));
const images = data.flatMap((m) => [m.thumb, ...m.images.map((i) => i.src)]).filter(Boolean);

await rm(DIST, { recursive: true, force: true });
let bytes = 0;
const missing = [];
for (const rel of [...PAGE_FILES, ...new Set(images)]) {
  const from = join(ROOT, rel), to = join(DIST, rel);
  try {
    bytes += (await stat(from)).size;
  } catch {
    missing.push(rel);
    continue;
  }
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`dist/：${data.length} 种，${PAGE_FILES.length + new Set(images).size - missing.length} 个文件，${mb(bytes)}`);
if (missing.length) {
  console.error(`缺少 ${missing.length} 个文件，请先运行 node scripts/fetch.mjs：\n  ` + missing.slice(0, 10).join('\n  '));
  process.exitCode = 1;
}

if (process.argv.includes('--tar') && !missing.length) {
  // 用相对路径调用系统自带的 tar（Windows 10+、macOS、Linux 都有）
  execFileSync('tar', ['-czf', ARCHIVE, '-C', 'dist', '.'], { cwd: ROOT, stdio: 'inherit' });
  console.log(`${ARCHIVE}：${mb((await stat(join(ROOT, ARCHIVE))).size)}`);
}
