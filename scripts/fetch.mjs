// 读取 data/species.json，从维基百科 / 维基共享资源 / iNaturalist 补全
// 百科摘要、来源链接和图片（每种最多 MAX_IMAGES 张，转成 WebP 存到 images/，保留署名），
// 输出 data/mushrooms.js 和 CREDITS.md。
// 用法：npm install                    （首次，安装图片处理库 sharp）
//       node scripts/fetch.mjs         （已处理过的物种会跳过）
//       node scripts/fetch.mjs --force （全部重新抓取；原图有本地缓存，不会重复下载）
import { readFile, writeFile, mkdir, access, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = join(ROOT, 'images');
const THUMB_DIR = join(IMG_DIR, 'thumb');
const CACHE_DIR = join(ROOT, 'scripts/.cache');
const FORCE = process.argv.includes('--force');
const UA = 'mushroom-guide/0.1 (personal offline field guide)';

const MAX_IMAGES = 5;
const FULL = { size: 960, quality: 78 };               // 详情页大图：长边不超过 960
const THUMB = { width: 420, height: 315, quality: 72 }; // 首页卡片缩略图：4:3 裁切
// 只用允许转换格式、署名即可使用的许可；无许可（保留所有权利）和禁止演绎（ND）的跳过
const OK_LICENSE = /^(cc0|cc-by|cc-by-sa|cc-by-nc|cc-by-nc-sa|pd)$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// 每个域名的请求间隔（毫秒）；遇到 429/5xx 按 Retry-After 退避重试
const GAP = { default: 1100, 'inaturalist-open-data.s3.amazonaws.com': 250, 'static.inaturalist.org': 250 };
const TRIES = 5;
const lastHit = new Map();
async function politeFetch(url, headers = {}) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) || 0) + (GAP[host] ?? GAP.default) - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit.set(host, Date.now());
    let err;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(30000) });
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      err = `HTTP ${res.status}`;
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < TRIES) await sleep(Math.min(retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt, 60000));
    } catch (e) {
      err = e.message;
      if (attempt < TRIES) await sleep(3000 * attempt);
    }
    if (attempt >= TRIES) { console.warn(`    ! ${url} -> ${err}`); return null; }
  }
}

async function getJson(url, headers) {
  const res = await politeFetch(url, headers);
  return res?.ok ? res.json() : null;
}

// 下载原图到本地缓存，返回缓存文件路径
async function fetchRaw(url) {
  const file = join(CACHE_DIR, createHash('sha1').update(url).digest('hex'));
  if (await exists(file)) return file;
  const res = await politeFetch(url);
  if (!res?.ok) { if (res) console.warn(`    ! 图片下载失败 ${url} -> HTTP ${res.status}`); return null; }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ---------- 维基百科 ----------
// 批量查英文维基：学名 -> { title, qid, image }
async function enLookup(latins) {
  const out = {};
  for (const part of chunk(latins, 50)) {
    const j = await getJson('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1' +
      '&prop=pageprops|pageimages&ppprop=wikibase_item&piprop=original&pilimit=50&titles=' + encodeURIComponent(part.join('|')));
    const q = j?.query;
    if (!q) continue;
    const hop = (list, t) => list?.find((x) => x.from === t)?.to || t;
    for (const latin of part) {
      const title = hop(q.redirects, hop(q.normalized, latin));
      const page = q.pages?.find((p) => p.title === title && !p.missing);
      if (page) out[latin] = { title, qid: page.pageprops?.wikibase_item, image: page.original?.source };
    }
  }
  return out;
}

// 批量查 Wikidata：qid -> 中文维基标题
async function zhTitles(qids) {
  const out = {};
  for (const part of chunk(qids, 50)) {
    const j = await getJson('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks&sitefilter=zhwiki&ids=' + part.join('|'));
    for (const [qid, e] of Object.entries(j?.entities || {})) if (e.sitelinks?.zhwiki) out[qid] = e.sitelinks.zhwiki.title;
  }
  return out;
}

async function zhSummary(title) {
  const j = await getJson(`https://zh.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`, { 'Accept-Language': 'zh-cn' });
  return j && j.type === 'standard' ? j : null;
}

// 向 Commons 要指定宽度的缩略图地址以及作者/许可信息
async function commonsPhoto(originalUrl) {
  const file = decodeURIComponent(new URL(originalUrl).pathname.split('/').pop());
  const j = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=${FULL.size}&titles=${encodeURIComponent('File:' + file)}`);
  const info = Object.values(j?.query?.pages || {})[0]?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata || {};
  return {
    from: info.thumburl || info.url,
    author: stripHtml(meta.Artist?.value) || '未知作者',
    license: stripHtml(meta.LicenseShortName?.value) || '',
    url: info.descriptionurl,
  };
}

// ---------- iNaturalist ----------
// 学名 -> 物种相册（社区挑选的代表性照片），只保留许可允许的
async function inatLookup(latins) {
  const idOf = {};
  for (const latin of latins) {
    const j = await getJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(latin)}&per_page=5`);
    const t = j?.results?.find((r) => r.name === latin) || j?.results?.find((r) => r.rank === 'species');
    if (t) idOf[latin] = t.id;
  }
  const photosOf = {};
  for (const part of chunk([...new Set(Object.values(idOf))], 30)) {
    const j = await getJson(`https://api.inaturalist.org/v1/taxa/${part.join(',')}`);
    for (const t of j?.results || []) {
      photosOf[t.id] = (t.taxon_photos || []).map((tp) => tp.photo)
        .filter((p) => OK_LICENSE.test(p.license_code || '') && p.large_url)
        .map((p) => ({
          from: p.large_url,
          author: p.attribution_name || stripHtml(p.attribution) || '未知作者',
          license: p.license_code.toUpperCase(),
          url: `https://www.inaturalist.org/photos/${p.id}`,
        }));
    }
  }
  return Object.fromEntries(Object.entries(idOf).map(([latin, id]) => [latin, photosOf[id] || []]));
}

// ---------- 查重 ----------
// 同一位作者常把同一张照片分别传到维基共享资源和 iNaturalist，且裁切范围不同，
// 所以不能比文件或整幅画面：把一张图的各种裁切窗口与另一张整幅做归一化互相关，
// 取最高分。只在作者相同的图片之间比较，分数超过 SAME_SHOT 视为同一张照片。
const SAME_SHOT = 0.88;
const G = 96, P = 32;
const WIN_SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6];
const WIN_OFFSETS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
const grayOf = (file) => sharp(file).rotate().greyscale().resize(G, G, { fit: 'fill' }).raw().toBuffer();

// 把灰度图的一个窗口重采样成 PxP 并标准化（零均值、单位长度），点积即相关系数
function patch(g, x0, y0, w, h) {
  const p = new Float64Array(P * P);
  let mean = 0;
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const v = g[Math.min(G - 1, Math.floor(y0 + ((y + 0.5) * h) / P)) * G + Math.min(G - 1, Math.floor(x0 + ((x + 0.5) * w) / P))];
    p[y * P + x] = v;
    mean += v;
  }
  mean /= p.length;
  let ss = 0;
  for (let i = 0; i < p.length; i++) { p[i] -= mean; ss += p[i] * p[i]; }
  const norm = Math.sqrt(ss) || 1;
  for (let i = 0; i < p.length; i++) p[i] /= norm;
  return p;
}

function bestWindow(g, whole) {
  let best = -1;
  for (const sx of WIN_SCALES) for (const sy of WIN_SCALES) {
    for (const ox of sx === 1 ? [0] : WIN_OFFSETS) for (const oy of sy === 1 ? [0] : WIN_OFFSETS) {
      const p = patch(g, (G - G * sx) * ox, (G - G * sy) * oy, G * sx, G * sy);
      let s = 0;
      for (let i = 0; i < p.length; i++) s += p[i] * whole[i];
      if (s > best) best = s;
    }
  }
  return best;
}

const sameShot = (a, b) => Math.max(bestWindow(a, patch(b, 0, 0, G, G)), bestWindow(b, patch(a, 0, 0, G, G))) >= SAME_SHOT;
const authorKey = (s) => (s || '').trim().toLowerCase();

// ---------- 单个物种 ----------
const slugOf = (latin) => latin.toLowerCase().replace(/[^a-z]+/g, '-');

async function isFresh(prev) {
  if (FORCE || !prev?.source || !prev.thumb || !prev.images?.length) return false;
  for (const p of [prev.thumb, ...prev.images.map((i) => i.src)]) if (!await exists(join(ROOT, p))) return false;
  return true;
}

async function build(sp, en, inat) {
  const slug = slugOf(sp.latin);
  const { wiki, imageFrom, image, credit, ...out } = sp;
  out.id = slug;

  const zhTitle = wiki || en?.zhTitle;
  const zh = zhTitle ? await zhSummary(zhTitle) : null;
  out.extract = zh?.extract || '';
  out.source = zh ? { name: '维基百科', url: zh.content_urls.desktop.page }
    : en ? { name: '英文维基百科', url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(en.title.replace(/ /g, '_')) }
    : null;

  // 候选图片的顺序：自备图片 > 维基条目主图 > iNaturalist 相册
  const candidates = [];
  if (image) {
    if (await exists(join(ROOT, image))) candidates.push({ file: join(ROOT, image), ...(credit || {}) });
    else console.warn(`    ! ${sp.zh}：找不到自备图片 ${image}`);
  }
  // "imageFrom":"inaturalist" 用于维基主图不是蘑菇照片（如分布地图）的条目
  const original = imageFrom === 'inaturalist' ? null : zh?.originalimage?.source || en?.image;
  const wikiPhoto = original && await commonsPhoto(original);
  if (wikiPhoto) candidates.push(wikiPhoto);
  candidates.push(...(inat || []));

  out.images = [];
  const kept = []; // 已采用图片的 { author, gray }，用于查重
  for (const c of candidates) {
    if (out.images.length >= MAX_IMAGES) break;
    const raw = c.file || await fetchRaw(c.from);
    if (!raw) continue;
    const n = out.images.length + 1;
    const src = `images/${slug}-${n}.webp`;
    try {
      const gray = await grayOf(raw);
      if (kept.some((k) => k.author === authorKey(c.author) && sameShot(k.gray, gray))) {
        console.log(`    - ${sp.zh}：跳过重复图片 ${c.url || c.from}`);
        continue;
      }
      kept.push({ author: authorKey(c.author), gray });
      const img = sharp(raw).rotate();
      await img.clone().resize(FULL.size, FULL.size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: FULL.quality }).toFile(join(ROOT, src));
      if (n === 1) {
        out.thumb = `images/thumb/${slug}.webp`;
        await img.clone().resize(THUMB.width, THUMB.height, { fit: 'cover', position: sharp.strategy.attention })
          .webp({ quality: THUMB.quality }).toFile(join(ROOT, out.thumb));
      }
    } catch (e) {
      console.warn(`    ! ${sp.zh}：图片处理失败 ${c.from || c.file} -> ${e.message}`);
      continue;
    }
    out.images.push({ src, author: c.author || '', license: c.license || '', url: c.url || '' });
  }
  return out;
}

// ---------- 主流程 ----------
const species = JSON.parse(await readFile(join(ROOT, 'data/species.json'), 'utf8'));
for (const d of [THUMB_DIR, CACHE_DIR]) await mkdir(d, { recursive: true });

const prevByLatin = {};
try {
  const js = await readFile(join(ROOT, 'data/mushrooms.js'), 'utf8');
  for (const m of JSON.parse(js.slice(js.indexOf('['), js.lastIndexOf(']') + 1))) prevByLatin[m.latin] = m;
} catch { /* 首次运行 */ }

const fresh = {};
for (const sp of species) fresh[sp.latin] = await isFresh(prevByLatin[sp.latin]);
const todo = species.filter((sp) => !fresh[sp.latin]).map((sp) => sp.latin);
console.log(`共 ${species.length} 种，需要联网处理 ${todo.length} 种`);

const en = await enLookup(todo);
const zhByQid = await zhTitles(Object.values(en).map((e) => e.qid).filter(Boolean));
for (const e of Object.values(en)) e.zhTitle = zhByQid[e.qid];
const inat = await inatLookup(todo);

const result = [];
for (const [i, sp] of species.entries()) {
  let m;
  if (fresh[sp.latin]) {
    // 标签和描述以 species.json 为准，百科摘要和图片沿用上次的结果
    const { extract, source, thumb, images } = prevByLatin[sp.latin];
    const { wiki, imageFrom, image, credit, ...tags } = sp;
    m = { ...tags, id: slugOf(sp.latin), extract, source, thumb, images };
  } else {
    m = await build(sp, en[sp.latin], inat[sp.latin]);
    console.log(`[${i + 1}/${species.length}] ${sp.zh} ${sp.latin}  ${m.source ? '百科✓' : '百科✗'} 图×${m.images.length}`);
  }
  result.push(m);
}

await writeFile(join(ROOT, 'data/mushrooms.js'),
  '// 由 scripts/fetch.mjs 生成，请勿手改；要改标签请编辑 species.json 后重新运行脚本。\n' +
  'window.MUSHROOMS = ' + JSON.stringify(result, null, 1) + ';\n');

const creditRow = (m, img, n) => `| ${m.zh} ${n} | *${m.latin}* | ${(img.author || '—').replaceAll('|', '/')} | ${img.license || '—'} | ${img.url ? `[链接](${img.url})` : '—'} |`;
await writeFile(join(ROOT, 'CREDITS.md'), [
  '# 图片署名',
  '',
  '由 scripts/fetch.mjs 生成。每张图片的版权归原作者所有，按所列许可使用；图片经过缩小并转换为 WebP 格式。',
  '',
  '| 图片 | 学名 | 作者 | 许可 | 来源 |',
  '|---|---|---|---|---|',
  ...result.flatMap((m) => m.images.map((img, i) => creditRow(m, img, i + 1))),
  '',
].join('\n'));

// 清理不再被引用的图片文件
const used = new Set(result.flatMap((m) => [m.thumb, ...m.images.map((i) => i.src)]));
let removed = 0;
for (const [dir, rel] of [[IMG_DIR, 'images'], [THUMB_DIR, 'images/thumb']]) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    if (f.isFile() && !used.has(`${rel}/${f.name}`)) { await unlink(join(dir, f.name)); removed++; }
  }
}

const noImg = result.filter((m) => !m.images.length).map((m) => m.zh);
const noWiki = result.filter((m) => !m.source).map((m) => m.zh);
const total = result.reduce((n, m) => n + m.images.length, 0);
console.log(`\n完成：${result.length} 种，共 ${total} 张图${removed ? `，清理旧文件 ${removed} 个` : ''}。` +
  `无图 ${noImg.length}${noImg.length ? '（' + noImg.join('、') + '）' : ''}；无百科 ${noWiki.length}${noWiki.length ? '（' + noWiki.join('、') + '）' : ''}`);
