// 在 built-in browser 的 javascript_tool 里原样执行（REPL 语义，支持顶层 await）。
// 做三件事：展开正文里折叠的内容 → 抽出正文文字 → 列出图片和还没处理的交互控件。
// 返回值最后一个字段是 text，前面是元数据，方便先看清有哪些图片和组件。

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. 找正文容器：优先 article / main；否则从 h1 往上爬，直到父节点里出现 nav、footer、aside 为止。
let root = document.querySelector('article') || document.querySelector('main');
const h1 = (root || document).querySelector('h1');
if (!root && h1) {
  root = h1;
  while (root.parentElement && root.parentElement !== document.body
         && !root.parentElement.querySelector('nav, footer, aside')) {
    root = root.parentElement;
  }
}
root = root || document.body;

// 2. 展开折叠内容：最多 4 轮，直到没有新按钮可点（有的 solution 按钮要先点 hint 才出现）。
//    除了 "Show a strong answer" 这类按钮，也点只写着 "Hint" 的按钮。
const REVEAL = /^(show|reveal|view|see|display|expand)\b.*\b(answer|solution|hint|explanation|more|details|all)\b|^hints?$/i;
const clicked = new WeakSet();
let clicks = 0;
for (let round = 0; round < 4; round++) {
  let n = 0;
  root.querySelectorAll('details:not([open])').forEach(d => { d.open = true; n++; });
  for (const b of root.querySelectorAll('button, [role="button"]')) {
    const t = (b.innerText || '').trim();
    if (!clicked.has(b) && REVEAL.test(t)) { clicked.add(b); b.click(); n++; }
  }
  clicks += n;
  if (!n) break;
  await sleep(600);
}

// 3. 触发懒加载图片，再收集正文里的图片（按尺寸过滤掉 icon、头像）。
const imgEls = [...root.querySelectorAll('img')];
for (const img of imgEls) {
  img.loading = 'eager';
  if (!img.complete) { img.scrollIntoView({ block: 'center' }); await sleep(150); }
}
await sleep(300);

const headings = [...root.querySelectorAll('h1, h2, h3')];
const sectionOf = el => {
  let s = '';
  for (const h of headings) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) s = h.innerText.trim();
  }
  return s;
};

const seen = new Set();
const images = imgEls
  .filter(i => {
    const src = i.currentSrc || i.src;
    if (!src || seen.has(src)) return false;
    seen.add(src);
    return (i.naturalWidth >= 120 && i.naturalHeight >= 80) || !i.complete;
  })
  .map((i, k) => ({
    n: k + 1,
    src: i.currentSrc || i.src,
    alt: i.alt || '',
    w: i.naturalWidth,
    h: i.naturalHeight,
    caption: i.closest('figure')?.querySelector('figcaption')?.innerText.trim() || '',
    section: sectionOf(i),
  }));

// 4. 较大的 inline SVG：可能是静态图，也可能是交互组件里的图表。
const svgFigures = [...root.querySelectorAll('svg')]
  .filter(s => {
    const r = s.getBoundingClientRect();
    return r.width >= 240 && r.height >= 120 && !s.closest('button');
  })
  .map(s => {
    let p = s;
    for (let k = 0; k < 4 && p.parentElement; k++) p = p.parentElement;
    const r = s.getBoundingClientRect();
    return {
      section: sectionOf(s),
      w: Math.round(r.width),
      h: Math.round(r.height),
      interactive: !!p.querySelector('button, input, select, [role="slider"]'),
      bytes: s.outerHTML.length,
    };
  });

// 5. 还没点过的控件：通常是 tab、场景切换、Back/Next 步进、测验选项，需要逐个组件处理。
const controls = [...new Set(
  [...root.querySelectorAll('button, [role="tab"], input[type="range"], select')]
    .filter(b => !clicked.has(b))
    .map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50))
    .filter(t => t && !/^hide\b/i.test(t))
)];

// 6. 正文文字：去掉代码编辑器行号栏（连续的纯数字行），这部分只浪费 token。
const text = root.innerText.replace(/(?:^\d{1,3}\n){3,}/gm, '');

const result = {
  url: location.href,
  title: h1?.innerText.trim() || document.title,
  rootTag: root.tagName + (root.className ? '.' + String(root.className).split(' ')[0] : ''),
  clicks,
  images,
  svgFigures,
  controls,
  textLength: text.length,
  text,
};
result
