#!/usr/bin/env python3
"""检查中英对照 Markdown 的结构问题，代替「写完再整篇读一遍」。

用法:
  python3 -I check_md.py <file.md>                 结构检查，只打印有问题的地方
  python3 -I check_md.py <file.md> --mermaid-json  输出 Mermaid 块的 JSON 数组，填进 render_mermaid.js
"""
import json
import re
import sys
from pathlib import Path

CJK = re.compile(r"[一-鿿]")


def unpaired_quotes(lines):
    """英文引用块后面第一段非空内容应该是中文；返回没配上中文的引用块起始行号。"""
    bad, in_code, i = [], False, 0
    while i < len(lines):
        line = lines[i]
        if line.lstrip().startswith("```"):
            in_code = not in_code
            i += 1
            continue
        if not in_code and line.startswith(">") and not CJK.search(line):
            start = i
            while i < len(lines) and lines[i].startswith(">"):
                i += 1
            j = i
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j >= len(lines) or lines[j].startswith(">") or not CJK.search(lines[j]):
                bad.append(start + 1)
            continue
        i += 1
    return bad


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = Path(sys.argv[1])
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    mermaid = re.findall(r"^```mermaid\n(.*?)^```", text, re.S | re.M)

    if "--mermaid-json" in sys.argv:
        print(json.dumps(mermaid, ensure_ascii=False))
        return

    problems = []
    fences = sum(1 for line in lines if line.lstrip().startswith("```"))
    if fences % 2:
        problems.append(f"code fence 不成对：共 {fences} 个 ```")
    opened, closed = text.count("<details>"), text.count("</details>")
    if opened != closed:
        problems.append(f"<details> 有 {opened} 个，</details> 有 {closed} 个")
    for n in unpaired_quotes(lines):
        problems.append(f"第 {n} 行的英文引用块后面没有中文译文")
    image_refs = re.findall(r"!\[[^\]]*\]\(([^)\s]+)", text)
    for ref in image_refs:
        if not re.match(r"https?://", ref) and not (path.parent / ref).exists():
            problems.append(f"引用的本地图片不存在：{ref}")

    print(f"{path.name}: {len(lines)} 行，Mermaid {len(mermaid)} 张，图片引用 {len(image_refs)} 个")
    if problems:
        print("\n".join("- " + p for p in problems))
        sys.exit(1)
    print("结构检查通过")


if __name__ == "__main__":
    main()
