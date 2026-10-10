// 读取 data/species.json，从维基百科 / 维基共享资源 / iNaturalist 补全
// 百科摘要、来源链接和图片（下载到 images/，保留署名），输出 data/mushrooms.js。
// 用法：node scripts/fetch.mjs        （已下载的图片会跳过）
//       node scripts/fetch.mjs --force （全部重新抓取）
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMG_DIR = join(ROOT, 'images');
const FORCE = process.argv.includes('--force');
const UA = 'mushroom-guide/0.1 (personal offline field guide)';
const IMG_WIDTH = 640;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const stripHtml = (s) => (s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// 每个域名至少间隔 GAP 毫秒发一次请求；遇到 429/5xx 按 Retry-After 退避重试
const GAP = 1100, TRIES = 5;
const lastHit = new Map();
async function politeFetch(url, headers = {}) {
  const host = new URL(url).host;
  for (let attempt = 1; ; attempt++) {
    const wait = (lastHit.get(host) || 0) + GAP - Date.now();
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

async function download(url, dest) {
  const res = await politeFetch(url);
  if (!res?.ok) { if (res) console.warn(`    ! 图片下载失败 ${url} -> HTTP ${res.status}`); return false; }
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

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

async function wikiSummary(lang, title) {
  const headers = lang === 'zh' ? { 'Accept-Language': 'zh-cn' } : {};
  const j = await getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}?redirect=true`, headers);
  return j && j.type === 'standard' ? j : null;
}

// 向 Commons 要指定宽度的缩略图地址以及作者/许可信息
async function commonsInfo(originalUrl) {
  const file = decodeURIComponent(new URL(originalUrl).pathname.split('/').pop());
  const j = await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=${IMG_WIDTH}&titles=${encodeURIComponent('File:' + file)}`);
  const info = Object.values(j?.query?.pages || {})[0]?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata || {};
  return {
    url: info.thumburl || info.url,
    page: info.descriptionurl,
    author: stripHtml(meta.Artist?.value) || '未知作者',
    license: stripHtml(meta.LicenseShortName?.value) || '',
  };
}

async function inatPhoto(latin) {
  const j = await getJson(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(latin)}&per_page=5`);
  const t = j?.results?.find((r) => r.name === latin && r.default_photo) || j?.results?.find((r) => r.default_photo);
  if (!t) return null;
  const p = t.default_photo;
  return {
    url: p.medium_url,
    page: `https://www.inaturalist.org/taxa/${t.id}`,
    author: p.attribution_name || stripHtml(p.attribution),
    license: (p.license_code || '').toUpperCase(),
  };
}

async function build(sp, prev, en) {
  const slug = sp.latin.toLowerCase().replace(/[^a-z]+/g, '-');
  const out = { ...sp, id: slug };
  delete out.wiki;
  delete out.imageFrom;

  if (sp.image && !await exists(join(ROOT, sp.image))) console.warn(`    ! ${sp.zh}：找不到自备图片 ${sp.image}`);
  if (!FORCE && prev?.image && prev.source && await exists(join(ROOT, prev.image))) {
    // species.json 里手工指定的 image / credit 优先于抓取结果
    return { ...out, extract: prev.extract, source: prev.source, image: sp.image || prev.image, credit: sp.image ? sp.credit : prev.credit };
  }

  const zhTitle = sp.wiki || en?.zhTitle;
  const zh = zhTitle ? await wikiSummary('zh', zhTitle) : null;

  out.extract = zh?.extract || '';
  out.source = zh ? { name: '维基百科', url: zh.content_urls.desktop.page }
    : en ? { name: '英文维基百科', url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(en.title.replace(/ /g, '_')) }
    : null;

  // "imageFrom":"inaturalist" 用于维基主图不是蘑菇照片（如分布地图）的条目
  const original = sp.imageFrom === 'inaturalist' ? null : zh?.originalimage?.source || en?.image;
  const photo = sp.image ? null : (original && await commonsInfo(original)) || await inatPhoto(sp.latin);
  if (photo) {
    const ext = (extname(new URL(photo.url).pathname).toLowerCase().match(/^\.(jpe?g|png|webp|gif)$/) || ['.jpg'])[0];
    const rel = `images/${slug}${ext}`;
    if (await download(photo.url, join(ROOT, rel))) {
      out.image = rel;
      out.credit = { author: photo.author, license: photo.license, url: photo.page };
    }
  }
  return out;
}

const species = JSON.parse(await readFile(join(ROOT, 'data/species.json'), 'utf8'));
await mkdir(IMG_DIR, { recursive: true });

let prevById = {};
try {
  const js = await readFile(join(ROOT, 'data/mushrooms.js'), 'utf8');
  for (const m of JSON.parse(js.slice(js.indexOf('['), js.lastIndexOf(']') + 1))) prevById[m.latin] = m;
} catch { /* 首次运行 */ }

const en = await enLookup(species.map((s) => s.latin));
const zhByQid = await zhTitles(Object.values(en).map((e) => e.qid).filter(Boolean));
for (const e of Object.values(en)) e.zhTitle = zhByQid[e.qid];

const result = [];
for (const [i, sp] of species.entries()) {
  const m = await build(sp, prevById[sp.latin], en[sp.latin]);
  result.push(m);
  console.log(`[${i + 1}/${species.length}] ${sp.zh} ${sp.latin}  ${m.source ? '百科✓' : '百科✗'} ${m.image ? '图✓' : '图✗'}`);
}

await writeFile(join(ROOT, 'data/mushrooms.js'),
  '// 由 scripts/fetch.mjs 生成，请勿手改；要改标签请编辑 species.json 后重新运行脚本。\n' +
  'window.MUSHROOMS = ' + JSON.stringify(result, null, 1) + ';\n');

const creditRow = (m) => `| ${m.zh} | *${m.latin}* | ${(m.credit?.author || '—').replaceAll('|', '/')} | ${m.credit?.license || '—'} | ${m.credit?.url ? `[链接](${m.credit.url})` : '—'} |`;
await writeFile(join(ROOT, 'CREDITS.md'), [
  '# 图片署名',
  '',
  '由 scripts/fetch.mjs 生成。每张图片的版权归原作者所有，按所列许可使用。',
  '',
  '| 物种 | 学名 | 作者 | 许可 | 来源 |',
  '|---|---|---|---|---|',
  ...result.filter((m) => m.image).map(creditRow),
  '',
].join('\n'));

const noImg = result.filter((m) => !m.image).map((m) => m.zh);
const noWiki = result.filter((m) => !m.source).map((m) => m.zh);
console.log(`\n完成：${result.length} 种。无图 ${noImg.length}${noImg.length ? '（' + noImg.join('、') + '）' : ''}；无百科 ${noWiki.length}${noWiki.length ? '（' + noWiki.join('、') + '）' : ''}`);
