# -*- coding: utf-8 -*-
"""
生成公众号文章库双索引（文章 / 贴图各一份）。
用法: python gen_index.py [输出根目录] (默认 ./公众号文章下载)

输出结构（--out 为根目录，与 download.js 一致）:
  <root>/公众号文章/公众号文章索引.md
  <root>/公众号贴图/公众号贴图索引.md

索引格式：日期倒序、每月一组，三列表格「发表日期 | 标题 | 主要内容」。
摘要规则：取正文第一段（跳过标题/引用/推广行），过短则拼接下一段，截取 90 字。
兼容：若根目录下直接散落 .md（旧版混放结构），自动提示先运行 migrate_split.py 迁移。
"""
import os, re, sys, datetime

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.getcwd(), "公众号文章下载")
ARTICLE_DIR = os.path.join(ROOT, "公众号文章")
TUITU_DIR = os.path.join(ROOT, "公众号贴图")

PROMO = re.compile(r"^(请关注|关注)本?公众号|^点击上方|^↑?点击蓝字|^设为星标|^作者|^来源[:：]?$")
# 正文模板残留前缀（贴图/日报等）
PREFIX_NOISE = re.compile(r"^(DAILY REPORT|WEEKLY REVIEW ?·?|SPECIAL REPORT)\s*", re.I)

def clean_text(l):
    l = re.sub(r"[#*_>\[\]!`]", "", l).strip()
    l = PREFIX_NOISE.sub("", l).strip()
    return l

def norm_date(s):
    """归一化日期为 YYYY-MM-DD；失败返回 None"""
    m = re.match(r"^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})", str(s).strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (2000 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"

def parse_md(path):
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
    except Exception:
        return None, []
    fm_date = None
    m = re.match(r"^---\s*\ntitle:\s*\"?(.*?)\"?\s*\ndate:\s*(\S+)", txt)
    if m:
        fm_date = norm_date(m.group(2))
    body = re.sub(r"^---.*?---\s*", "", txt, flags=re.S)
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    paras = []
    for l in lines:
        if l.startswith("# ") or l.startswith("> ") or l.startswith("!["):
            continue
        clean = clean_text(l)
        if len(clean) < 12 or PROMO.match(clean):
            continue
        paras.append(clean)
        if len(paras) >= 3:
            break
    return fm_date, paras

def make_summary(paras):
    if not paras:
        return ""
    s = paras[0]
    if len(s) < 30 and len(paras) > 1:
        s = s + " " + paras[1]
    return s[:90] + ("…" if len(s) > 90 else "")

def scan_dir(d, exclude):
    """扫描目录，返回 [(date, title, summary)]"""
    if not os.path.isdir(d):
        return []
    rows = []
    for f in os.listdir(d):
        if not f.endswith(".md") or f.startswith((".", "_")) or f in exclude:
            continue
        m = re.match(r"^(\d{4}-\d{1,2}-\d{1,2})_(.+)\.md$", f)
        file_date, title = (norm_date(m.group(1)), m.group(2)) if m else (None, f[:-3])
        fm_date, paras = parse_md(os.path.join(d, f))
        date = fm_date or file_date or "0000-00-00"
        rows.append((date, title or "", make_summary(paras)))
    rows.sort(key=lambda x: x[0], reverse=True)
    return rows

def write_index(out_path, rows, label):
    latest = rows[0][0] if rows and rows[0][0] != "0000-00-00" else "N/A"
    by_month = {}
    for date, title, summary in rows:
        by_month.setdefault(date[:7], []).append((date, title, summary))
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    esc = lambda s: s.replace("|", "\\|")
    out = []
    out.append(f"# {label}")
    out.append("")
    out.append(f"> 共 **{len(rows)}** 篇 | 最近发表：**{latest}** | 生成时间：{now}")
    out.append("> 用途：写作前查重速览，日期倒序，每月一组。")
    out.append("")
    for month in sorted(by_month.keys(), reverse=True):
        out.append(f"## {month}（{len(by_month[month])} 篇）")
        out.append("")
        out.append("| 日期 | 标题 | 主要内容 |")
        out.append("|------|------|----------|")
        for date, title, summary in sorted(by_month[month], key=lambda x: x[0], reverse=True):
            out.append(f"| {date} | {esc(title)} | {esc(summary)} |")
        out.append("")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print(f"已生成: {out_path}（{len(rows)} 篇，最近发表 {latest}）")

def main():
    exclude_a = {"公众号文章索引.md"}
    exclude_t = {"公众号贴图索引.md"}
    # 兼容旧结构：根目录直接散落 md
    loose = []
    if os.path.isdir(ROOT):
        loose = [f for f in os.listdir(ROOT) if f.endswith(".md") and not f.startswith((".", "_"))]
    if loose:
        print(f"⚠ 根目录发现 {len(loose)} 个散落 md（旧版混放结构），请运行 migrate_split.py 迁移后再生成索引。")

    rows_a = scan_dir(ARTICLE_DIR, exclude_a)
    rows_t = scan_dir(TUITU_DIR, exclude_t)
    if rows_a:
        write_index(os.path.join(ARTICLE_DIR, "公众号文章索引.md"), rows_a, "公众号文章索引")
    if rows_t:
        write_index(os.path.join(TUITU_DIR, "公众号贴图索引.md"), rows_t, "公众号贴图索引")
    if not rows_a and not rows_t:
        print(f"未发现内容：{ROOT}（需包含 公众号文章/ 或 公众号贴图/ 子目录）")

if __name__ == "__main__":
    main()
