(() => {
  const DATA = window.MUSHROOMS || [];

  const TOX_ORDER = ['剧毒', '有毒', '慎食', '不可食', '可食用'];
  const CN_REGIONS = ['东北', '华北', '华东', '华中', '华南', '西南', '西北', '青藏高原'];
  const COLOR_HEX = {
    白: '#fafafa', 黄: '#f2c81e', 橙: '#f08a24', 红: '#d6312b', 粉: '#f3a6b8', 紫: '#7d4bb0',
    蓝: '#2d6fd1', 绿: '#5f9e4a', 褐: '#8a5a33', 灰: '#9a9a9a', 黑: '#222222',
  };

  // key 对应 species.json 里的字段；order 里没列出的值按出现次数排在后面
  const FACETS = [
    { key: 'tox', label: '毒性', order: TOX_ORDER },
    { key: 'colors', label: '颜色', order: Object.keys(COLOR_HEX) },
    { key: 'shape', label: '形状' },
    { key: 'regions', label: '区域', order: CN_REGIONS },
    { key: 'habitat', label: '生境' },
    { key: 'season', label: '季节', order: ['春', '夏', '秋', '冬'] },
    { key: 'traits', label: '特征' },
  ];

  const values = (m, key) => [].concat(m[key] ?? []);
  for (const m of DATA) {
    m._text = [m.zh, m.latin, ...(m.alias || []), m.note, m.extract, ...FACETS.flatMap((f) => values(m, f.key))]
      .join(' ').toLowerCase();
  }

  // ---------- 相似蘑菇 ----------
  // 先列人工整理的易混淆种（species.json 的 lookalikes，写一边即可，这里补成双向），
  // 不足 MAX_SIMILAR 个时按标签相近程度补齐
  const MAX_SIMILAR = 4;
  const byLatin = new Map(DATA.map((m) => [m.latin, m]));
  const lookalikes = new Map(DATA.map((m) => [m, new Set()]));
  for (const m of DATA) {
    for (const latin of m.lookalikes || []) {
      const o = byLatin.get(latin);
      if (o && o !== m) { lookalikes.get(m).add(o); lookalikes.get(o).add(m); }
    }
  }
  const overlap = (a, b) => a.filter((v) => b.includes(v)).length / new Set([...a, ...b]).size;
  function likeness(a, b) {
    return 3 * (a.shape === b.shape) + 3 * overlap(a.colors, b.colors) + overlap(a.habitat, b.habitat) +
      2 * (a.latin.split(' ')[0] === b.latin.split(' ')[0]);
  }
  function similar(m) {
    const known = [...lookalikes.get(m)];
    const rest = DATA.filter((o) => o !== m && !known.includes(o))
      .map((o) => [likeness(m, o), o]).sort((x, y) => y[0] - x[0])
      .slice(0, Math.max(0, MAX_SIMILAR - known.length)).map(([, o]) => o);
    return [...known.map((o) => [o, true]), ...rest.map((o) => [o, false])];
  }

  const state = { q: '', sort: 'tox', sel: Object.fromEntries(FACETS.map((f) => [f.key, new Set()])) };

  const $ = (id) => document.getElementById(id);
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
    el.append(...children.flat().filter((c) => c != null && c !== false));
    return el;
  }

  // ---------- 筛选 ----------
  function matches(m, skipKey) {
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.every((t) => m._text.includes(t))) return false;
    // 同一类标签内为“或”，不同类之间为“且”
    return FACETS.every((f) => {
      const sel = state.sel[f.key];
      return f.key === skipKey || sel.size === 0 || values(m, f.key).some((v) => sel.has(v));
    });
  }

  function sorted(list) {
    const byZh = (a, b) => a.zh.localeCompare(b.zh, 'zh-Hans-CN');
    if (state.sort === 'zh') return list.sort(byZh);
    if (state.sort === 'latin') return list.sort((a, b) => a.latin.localeCompare(b.latin));
    return list.sort((a, b) => TOX_ORDER.indexOf(a.tox) - TOX_ORDER.indexOf(b.tox) || byZh(a, b));
  }

  function toggle(key, value) {
    const sel = state.sel[key];
    sel.has(value) ? sel.delete(value) : sel.add(value);
    render();
  }

  // ---------- 渲染 ----------
  const swatch = (c) => COLOR_HEX[c] && h('span', { class: 'swatch', style: `background:${COLOR_HEX[c]}` });

  function chip(key, value, count) {
    const pressed = state.sel[key].has(value);
    return h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(pressed),
      disabled: count === 0 && !pressed,
      onclick: () => toggle(key, value),
    }, key === 'colors' && swatch(value), value, count != null && h('span', { class: 'n' }, String(count)));
  }

  function renderFacets() {
    const openState = Object.fromEntries([...$('facets').querySelectorAll('details')].map((d) => [d.dataset.key, d.open]));
    $('facets').replaceChildren(...FACETS.map((f) => {
      // 每个标签的计数 = 在其它筛选条件不变时，选它能得到多少结果
      const pool = DATA.filter((m) => matches(m, f.key));
      const counts = new Map();
      for (const m of DATA) for (const v of values(m, f.key)) if (!counts.has(v)) counts.set(v, 0);
      for (const m of pool) for (const v of values(m, f.key)) counts.set(v, counts.get(v) + 1);
      const rank = (v) => { const i = (f.order || []).indexOf(v); return i < 0 ? Infinity : i; };
      const total = new Map();
      for (const m of DATA) for (const v of values(m, f.key)) total.set(v, (total.get(v) || 0) + 1);
      const vals = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || total.get(b) - total.get(a));
      return h('details', { class: 'facet', open: openState[f.key] ?? true, dataset: { key: f.key } },
        h('summary', {}, f.label),
        h('div', { class: 'chips' }, vals.map((v) => chip(f.key, v, counts.get(v)))));
    }));
  }

  function card(m) {
    return h('button', { class: 'card', type: 'button', onclick: () => openDetail(m) },
      h('div', { class: 'thumb' },
        m.thumb ? h('img', { src: m.thumb, alt: m.zh, loading: 'lazy', width: 420, height: 315 }) : h('div', { class: 'noimg' }, '🍄'),
        h('span', { class: 'tox', dataset: { tox: m.tox } }, m.tox)),
      h('div', { class: 'card-body' },
        h('h2', {}, m.zh),
        h('div', { class: 'latin' }, m.latin),
        h('div', { class: 'mini' },
          m.colors.map((c) => h('span', {}, swatch(c), c)),
          h('span', {}, m.shape),
          m.regions.slice(0, 3).map((r) => h('span', {}, r)),
          m.regions.length > 3 && h('span', {}, `+${m.regions.length - 3}`))));
  }

  function renderStatus(n) {
    $('count').textContent = `共 ${n} / ${DATA.length} 种`;
    const active = FACETS.flatMap((f) => [...state.sel[f.key]].map((v) => chip(f.key, v)));
    $('active').replaceChildren(...active);
    $('clear').hidden = active.length === 0 && !state.q;
  }

  function render() {
    const list = sorted(DATA.filter((m) => matches(m)));
    renderFacets();
    renderStatus(list.length);
    $('grid').replaceChildren(...list.map(card));
    $('empty').hidden = list.length > 0;
    saveHash();
  }

  // ---------- 详情 ----------
  // 固定尺寸的画框，图片完整缩放进去；横向 scroll-snap 提供触屏左右滑动，
  // 按钮和方向键只是去滚动同一个容器
  function gallery(m) {
    const imgs = m.images || [];
    if (!imgs.length) return null;
    const track = h('div', { class: 'g-track', tabIndex: 0, 'aria-label': `${m.zh}的图片，共 ${imgs.length} 张` },
      imgs.map((img, i) => h('div', { class: 'g-slide' },
        h('img', { src: img.src, alt: `${m.zh} ${i + 1}`, loading: i ? 'lazy' : 'eager', draggable: false }))));
    const credit = h('div', { class: 'g-credit' });
    const counter = h('span', { class: 'g-count' });
    const dots = imgs.map((_, i) => h('button', { class: 'g-dot', type: 'button', 'aria-label': `第 ${i + 1} 张`, onclick: () => go(i) }));
    const prev = h('button', { class: 'g-nav g-prev', type: 'button', 'aria-label': '上一张', onclick: () => go(index - 1) }, '‹');
    const next = h('button', { class: 'g-nav g-next', type: 'button', 'aria-label': '下一张', onclick: () => go(index + 1) }, '›');
    let index = -1;

    function show(i) {
      if (i === index) return;
      index = i;
      const img = imgs[i];
      credit.replaceChildren('图片：',
        img.url ? h('a', { href: img.url, target: '_blank', rel: 'noopener' }, img.author || '来源') : (img.author || '未注明'),
        img.license ? `（${img.license}）` : '');
      counter.textContent = `${i + 1} / ${imgs.length}`;
      dots.forEach((d, j) => d.setAttribute('aria-current', String(j === i)));
      prev.disabled = i === 0;
      next.disabled = i === imgs.length - 1;
    }
    function go(i) {
      i = Math.max(0, Math.min(imgs.length - 1, i));
      track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' });
    }
    track.addEventListener('scroll', () => show(Math.round(track.scrollLeft / track.clientWidth)));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { go(index - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { go(index + 1); e.preventDefault(); }
    });
    show(0);

    const multi = imgs.length > 1;
    return h('div', { class: 'gallery' },
      h('div', { class: 'g-frame' }, track, multi && prev, multi && next, multi && counter),
      h('div', { class: 'g-foot' }, credit, multi && h('div', { class: 'g-dots' }, dots)));
  }

  function openDetail(m) {
    const dlg = $('detail');
    const jump = (key, v) => () => {
      for (const f of FACETS) state.sel[f.key].clear();
      state.q = $('q').value = '';
      state.sel[key].add(v);
      dlg.close();
      render();
      scrollTo({ top: 0 });
    };
    dlg.replaceChildren(
      h('button', { class: 'd-close', type: 'button', 'aria-label': '关闭', onclick: () => dlg.close() }, '✕'),
      gallery(m),
      h('div', { class: 'd-body' },
        h('div', { class: 'd-head' },
          h('h2', { id: 'd-title' }, m.zh),
          h('span', { class: 'latin' }, m.latin),
          h('span', { class: 'tox', dataset: { tox: m.tox } }, m.tox)),
        m.alias?.length > 0 && h('p', { class: 'alias' }, '别名：' + m.alias.join('、')),
        h('p', { class: 'note' }, m.note),
        m.extract && h('div', { class: 'extract' }, h('b', {}, '百科摘要'), h('p', {}, m.extract)),
        h('dl', { class: 'd-tags' }, FACETS.flatMap((f) => {
          const vs = values(m, f.key);
          return vs.length ? [h('dt', {}, f.label), h('dd', {}, vs.map((v) =>
            h('button', { class: 'chip', type: 'button', title: `查看所有“${v}”`, onclick: jump(f.key, v) },
              f.key === 'colors' && swatch(v), v)))] : [];
        }),
          h('dt', {}, '相似'),
          h('dd', {}, similar(m).map(([o, confusable]) =>
            h('button', {
              class: 'chip sim', type: 'button', dataset: { tox: o.tox, confusable: String(confusable) },
              title: (confusable ? '容易混淆：' : '外观相近：') + `${o.zh}（${o.tox}）`,
              onclick: () => openDetail(o),
            }, o.thumb && h('img', { src: o.thumb, alt: '' }), o.zh, confusable && h('span', { class: 'sim-flag' }, '易混'))))),
        m.source && h('a', { href: m.source.url, target: '_blank', rel: 'noopener' }, `在${m.source.name}查看完整条目 ↗`)));
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    dlg.querySelector('.g-track')?.focus({ preventScroll: true });
    opened = m.id;
    saveHash();
  }
  let opened = null;
  $('detail').addEventListener('close', () => { opened = null; saveHash(); });
  $('detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  // ---------- 地址栏状态（方便收藏/分享某个筛选结果） ----------
  function saveHash() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'tox') p.set('sort', state.sort);
    for (const f of FACETS) if (state.sel[f.key].size) p.set(f.key, [...state.sel[f.key]].join(','));
    if (opened) p.set('m', opened);
    history.replaceState(null, '', p.size ? '#' + p : location.pathname + location.search);
  }
  function loadHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    state.q = $('q').value = p.get('q') || '';
    state.sort = $('sort').value = p.get('sort') || 'tox';
    if (!$('sort').value) state.sort = $('sort').value = 'tox';
    for (const f of FACETS) state.sel[f.key] = new Set((p.get(f.key) || '').split(',').filter(Boolean));
    return DATA.find((m) => m.id === p.get('m'));
  }

  $('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('clear').addEventListener('click', () => {
    for (const f of FACETS) state.sel[f.key].clear();
    state.q = $('q').value = '';
    render();
  });
  addEventListener('hashchange', () => { const m = loadHash(); render(); if (m && m.id !== opened) openDetail(m); });

  if (!DATA.length) {
    $('empty').hidden = false;
    $('empty').textContent = '没有找到数据：请先运行 node scripts/fetch.mjs 生成 data/mushrooms.js。';
  } else {
    const m = loadHash();
    render();
    if (m) openDetail(m);
  }
})();
