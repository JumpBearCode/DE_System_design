---
name: web-to-bilingual-md
description: 把一个网页（课程章节、技术博客、文档页、面试指南）翻译整理成中英逐段对照的 Markdown，存进项目的 doc/，网页里的图片一并下载到本地引用。用户贴出 URL 并说「翻译一下」「整理成 Markdown」「中英对照」「帮我快速过一遍这篇」「下一课也照这样翻」时使用；即使只贴一个链接说「照之前那篇的格式来」，也用这个 skill。默认走省 token 的流程，最后只交付 MD 文件。
---

# 网页 → 中英逐段对照 Markdown

范例：同一个 doc 目录下的 `01-how-a-de-design-interview-runs.md`（本 skill 就是从它的制作过程总结出来的）。格式拿不准时只读其中相关的一小段，不要整篇读。

## 读者与翻译风格

读者是在美国工作的 senior engineer，技术术语都懂；中文只是为了更快读完这篇文章。

- 技术术语保留英文（partition、backfill、idempotent、freshness、grain、rerun…），其余用自然、口语化的中文。
- 言简意赅。原文笼统或啰嗦时，中文可以说得更清楚，也可以把长段拆成列表；读者遇到不一样的地方会自己对照英文。
- 只翻正文。导航、侧栏目录、营销 CTA、footer、「相关课程」都不要。
- 自己加的内容（速览、补画的图、对交互组件的说明）标「译注」，和原文分开。

## 输出位置

- MD：`doc/<站点或课程 slug>/<NN>-<lesson-slug>.md`。同一门课放同一个文件夹，NN 按课程里的顺序。
- 图片：`doc/<课程>/assets/<NN>-<lesson-slug>/fig-01.<ext>`，MD 里用相对路径引用。
- 目标文件已存在时先问用户：覆盖还是另存。

## 流程（省 token 模式）

省 token 靠四件事：页面只抓一次而且只抓正文；交互组件只回传组件自己的文字；MD 一次写完；用脚本检查代替整篇回读。截图只在数字查不出问题时才用。

### 1. 打开页面

| 情况 | 用哪个浏览器 |
|---|---|
| 公开页面 | built-in browser（`mcp__Claude_Browser__*`）：`preview_start` 带 `url` |
| 付费或要登录的页面，或者用户点名要 Chrome | Claude in Chrome（`mcp__claude-in-chrome__*`），里面有用户的登录态。先 `tabs_context_mcp`，在自己新开的 tab 里打开，用完关掉 |

两边都有 `javascript_tool`、`get_page_text` 和截图，下面的步骤通用；Chrome 多两条限制，见第 2 步。

### 2. 一次调用：展开折叠内容 + 抽正文 + 列图片

Read `scripts/extract_article.js`，把内容原样作为 `javascript_tool` 的 `text` 执行。它会：

- 找正文容器：article / main；都没有时从 h1 往上找，直到碰到 nav、footer、aside 为止。
- 反复点击正文里 "Show answer / solution / hint / more" 一类按钮，打开所有 `<details>`。
- 返回 `images`（src、alt、caption、所在小节）、`svgFigures`、`controls`（还没点过的按钮文字）和 `text`（已去掉代码编辑器行号栏的正文）。

在 built-in browser 里，正文直接从 `text` 拿，不要再对整页用 `get_page_text`：它带着导航和 footer，展开前后各抓一次等于付两遍。`rootTag` 看起来不对（`textLength` 和正文明显对不上）时，再手动指定容器。

在 Chrome 里有两条限制：

- 返回值里看起来像 cookie 或 query string 的文字，会被扩展换成 `[BLOCKED: Cookie/query string data]`；超过约 1000 字符的字符串，会被截断成 `...[TRUNCATED]`。
- 所以在 Chrome 里，`text` 基本拿不全。这时直接调用 `get_page_text`：折叠内容已经在页面上展开了，读一次就够。不要用替换字符之类的办法绕过这个过滤，那是扩展的安全机制。

`get_page_text` 会丢掉代码缩进，代码按第 3 步单独取。

### 3. 交互组件：每个组件一次 JS 循环

`controls` 里剩下的通常是 tab、场景切换、Back / Next 步进、测验选项。每个组件写一次 JS：点击 → 等 300–500 ms → 取组件容器的 innerText（从按钮往上找，找到包含组件标题文字的祖先），一次调用拿完所有状态，只返回变化的那部分。

- 测验：只点正确选项拿解析。看不出哪个对时依次点，取出现 "Right" / "Correct" 的那条。
- 逐步演示：循环点 Next，直到按钮 disabled 或变成 Replay。
- 带滑块的图表不用逐个拖：把默认参数和读数整理成一张表，正文一般已经写了几组关键数字。
- 能在浏览器里跑代码的 playground 不用执行，正文一般已经写了结论数字。
- 某个状态的返回被 Chrome 拦成 `[BLOCKED…]` 时，把组件切到那个状态，`scrollIntoView` 后截一张 `scale: 0.6` 的图来读。
- 每个字符串都要短，避免被 Chrome 截断。比如要组件的文字，就只返回变化的那部分，不要返回整个容器。

代码：`.cm-line` 的 textContent 会保留缩进。按行返回数组，每行都很短，不会被截断：

```js
[...document.querySelectorAll('.cm-content')].map(ed => [...ed.querySelectorAll('.cm-line')].map(l => l.textContent))
```

- 编辑器只渲染可见的行，长代码的结尾可能取不到。取不到的部分按 `get_page_text` 的文字还原缩进，并在 MD 里标译注说明。
- 某段代码整体被拦时，同样按页面文字还原缩进。

### 4. 下载图片

`images` 非空时，按出现顺序下载：

```bash
mkdir -p doc/<课程>/assets/<NN-lesson>
curl -sSL --fail -o doc/<课程>/assets/<NN-lesson>/fig-01.png '<src>'
file doc/<课程>/assets/<NN-lesson>/*
```

- 扩展名按 `file` 识别出的真实类型改正。这些只是图片，不执行。
- 下载失败（403、需要登录）时，不要拿用户浏览器里的 cookie 去请求：MD 里直接引用原图 URL，交付时列出哪几张失败了。
- 明显是装饰用的图可以跳过，icon 和头像已经被脚本按尺寸过滤掉了。
- `svgFigures` 里 `interactive: false` 的是静态 inline SVG 图：结构简单就用 Mermaid 重画（标译注）；结构复杂才把 outerHTML 存成 `.svg`。`interactive: true` 的属于交互组件，按第 3 步处理。

### 5. 一次写完 MD

按下面的「MD 格式」用一次 Write 写完整个文件。写完不要 Read 回来通读，用脚本检查：

```bash
python3 -I <skill 目录>/scripts/check_md.py <md 路径>
```

它会报告 code fence 或 `<details>` 不成对、英文引用块后面漏了中文、本地图片不存在。只修它报出来的问题。

### 6. Mermaid 渲染检查（文档里有 Mermaid 时才做）

1. `python3 -I <skill 目录>/scripts/check_md.py <md 路径> --mermaid-json` 输出所有 Mermaid 块。
2. 新开一个 tab，navigate 到 `https://example.com`；Read `scripts/render_mermaid.js`，把 `__BLOCKS__` 换成上一步的 JSON 后执行。
3. 只修 `scale < 0.75`、`wrappedTitles` 非空或报 `error` 的图，修完重跑一次。数字正常时不截图。
4. 用完关掉自己开的这个 tab。

### 7. 交付

回复只写这几样：MD 的路径，哪些交互组件改写成了静态内容，哪些图片没下载成功，加了哪些译注。不发布 artifact，不 commit（commit 由用户决定）。

## MD 格式

````markdown
# <English title>｜<中文标题>

> 原文：[<站点 · 课程 · 章节>](<url>)，抓取于 <YYYY-MM-DD>。

译文说明：3–4 条，说清下面这些格式约定。

## 速览（译注）

3–5 条结论，每条一两句。

---

## <English H2>｜<中文 H2>

> English paragraph, copied verbatim.

对应的中文段落。

| English | 中文 |
|---|---|
| list item 1 | 列表项 1 |
````

各类内容的写法：

| 内容 | 写法 |
|---|---|
| 段落 | 英文放 `>` 引用块，中文紧跟在后面 |
| 列表、参考答案、自查清单 | 两栏表格「English \| 中文」，一行对一条 |
| 多列的大表格 | 直接放中文表；英文原表放进 `<details><summary>英文原表</summary>` |
| 图片 | `![<英文 alt>｜<中文说明>](assets/<NN-lesson>/fig-01.png)`；有 caption 时下面接英文引用块 + 中文 |
| 测验 | 表格列出 A–D 的中英选项，正确项标 ✅；解析用引用块 + 「解析：…」 |
| 折叠的 strong answer / hint / solution | 全部展开，标题写「参考答案（strong answer）」 |
| 交互组件 | 小标题注明「（原文为交互组件）」，改写成静态表格或 Mermaid；组件里的英文原文放进 `<details>` |
| 代码 | 原样保留，不翻注释；题目说明和 hint 照常中英对照；只读的长 playground 代码放进 `<details>` |

## Mermaid 规则（踩过的坑）

- 超过 4 个节点的链路用 `flowchart TB`。LR 在 760px 左右的文档宽度下会被缩到字看不清。
- 有跨组箭头时不要用 subgraph：Mermaid 会忽略 subgraph 自己的 direction，跨组箭头还会压在组标题上。分组的含义改写进 edge label，例如「每天 02:00 UTC<br/>读新到的 partition」。
- 所有标签用 `<br/>` 主动换行。sequence diagram 的 message 每行控制在 12 个汉字左右，否则整张图会被撑到 1000px 以上再整体缩小。
- subgraph 标题控制在约 200px 以内（大约 12 个汉字）。Mermaid 11 会把更长的标题折成两行，第二行会压在节点或箭头上。
