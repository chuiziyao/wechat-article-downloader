# -*- coding: utf-8 -*-
"""
一次性迁移脚本：把旧版「混放结构」文章库迁移为新的「文章/贴图分目录」结构。

旧结构:  <root>/*.md|*.html（真文章+贴图混放）、_贴图存档/（贴图）、_重复存档/、索引.md
新结构:  <root>/公众号文章/   （真文章 md+html）
        <root>/公众号贴图/   （贴图 md+html，来自 _贴图存档）
        <root>/_重复存档/    （保留，供查重参考）
        <root>/.download_state.json（保留）

用法: python migrate_split.py <文章库根目录>
"""
import os, re, shutil, sys

MARKERS = ("无双快讯", "更多名称已清空", "微信扫一扫赞赏作者")
INDEX_FILES = {"索引.md", "公众号文章索引.md", "公众号贴图索引.md"}

def is_tuitu(path):
    try:
        with open(path, encoding="utf-8") as f:
            t = f.read()
        return any(m in t for m in MARKERS)
    except Exception:
        return False

def main(root):
    if not os.path.isdir(root):
        print(f"目录不存在: {root}"); sys.exit(1)
    art = os.path.join(root, "公众号文章")
    tui = os.path.join(root, "公众号贴图")
    os.makedirs(art, exist_ok=True)
    os.makedirs(tui, exist_ok=True)

    moved_art = moved_tui = 0
    # 1) 贴图存档 → 公众号贴图/
    tuitu_arch = os.path.join(root, "_贴图存档")
    if os.path.isdir(tuitu_arch):
        for f in os.listdir(tuitu_arch):
            src = os.path.join(tuitu_arch, f)
            if os.path.isfile(src):
                shutil.move(src, os.path.join(tui, f))
                moved_tui += 1
        os.rmdir(tuitu_arch)

    # 2) 根目录散落 md/html：贴图 → 贴图目录，真文章 → 文章目录
    for f in sorted(os.listdir(root)):
        if not f.endswith((".md", ".html")) or f.startswith((".", "_")) or f in INDEX_FILES:
            continue
        src = os.path.join(root, f)
        if not os.path.isfile(src):
            continue
        if f.endswith(".md") and is_tuitu(src):
            shutil.move(src, os.path.join(tui, f)); moved_tui += 1
        else:
            shutil.move(src, os.path.join(art, f)); moved_art += 1

    # 3) 删除旧索引（稍后由 gen_index.py 重新生成两份）
    for name in INDEX_FILES:
        p = os.path.join(root, name)
        if os.path.exists(p):
            os.remove(p)

    print(f"迁移完成: 文章 {moved_art} 个文件 → 公众号文章/ | 贴图 {moved_tui} 个文件 → 公众号贴图/")
    print(f"文章 md 数: {len([f for f in os.listdir(art) if f.endswith('.md') and not f.startswith('公众号')])}")
    print(f"贴图 md 数: {len([f for f in os.listdir(tui) if f.endswith('.md') and not f.startswith('公众号')])}")
    # 残留贴图复查
    left_tuitu = [f for f in os.listdir(art) if f.endswith(".md") and not f.startswith("公众号") and is_tuitu(os.path.join(art, f))]
    print(f"文章目录残留贴图: {len(left_tuitu)}")
    for f in left_tuitu[:10]:
        print("  ", f)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.getcwd())
