// 用法：把下面的 __BLOCKS__ 换成 `check_md.py <md> --mermaid-json` 的输出，
// 然后在一个普通网页 tab（例如 https://example.com）里用 javascript_tool 执行。
// 返回每张图的尺寸、在文档宽度下的缩放比例、被折成多行的 subgraph 标题。
// 只有 scale < 0.75、wrappedTitles 非空或 error 的图才需要改；数字没问题就不用截图。

const blocks = __BLOCKS__;
const WIDTH = 760; // 常见 Markdown viewer（GitHub、VS Code 预览）的正文宽度

document.body.innerHTML = '';
document.body.style.cssText = 'background:#fff;margin:0;padding:10px;max-width:none';
if (!window.mermaid) {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
  document.head.appendChild(s);
  await new Promise((res, rej) => { s.onload = res; s.onerror = () => rej(new Error('mermaid load failed')); });
  mermaid.initialize({ startOnLoad: false, theme: 'default' });
}

const report = [];
for (let i = 0; i < blocks.length; i++) {
  const div = document.createElement('div');
  div.id = 'mm' + i;
  div.style.cssText = `width:${WIDTH}px;outline:1px solid #ccc;margin-bottom:12px`;
  document.body.appendChild(div);
  try {
    const { svg } = await mermaid.render(`mmsvg${i}_${Date.now()}`, blocks[i]);
    div.innerHTML = svg;
    const el = div.querySelector('svg');
    const vb = el.viewBox.baseVal;
    // Mermaid 11 会把超过约 200px 的 subgraph 标题折成多行，第二行会压在节点或箭头上。
    // 单行标题高 24px，折行后是 48px 起，所以按高度判断。
    const wrappedTitles = [...el.querySelectorAll('.cluster-label foreignObject')]
      .filter(fo => fo.height.baseVal.value > 30)
      .map(fo => fo.textContent.trim());
    report.push({
      i,
      firstLine: blocks[i].split('\n')[0],
      w: Math.round(vb.width),
      h: Math.round(vb.height),
      scale: +Math.min(1, WIDTH / vb.width).toFixed(2),
      wrappedTitles,
    });
  } catch (e) {
    report.push({ i, error: String(e.message || e).slice(0, 200) });
  }
}
report
