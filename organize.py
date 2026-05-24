import os
import re
import shutil

# 匹配文件名格式：YYYY-MM-DD_xxx.jpg 或 YYYY-MM-DD_NN_xxx.jpg
DATE_PATTERN = re.compile(r'^(\d{4}-\d{2}-\d{2})_')

def organize_by_date(target_dir=None):
    """将当前目录下带日期前缀的文件按日期整理到子文件夹"""
    target_dir = target_dir or os.getcwd()
    moved = 0

    for fname in os.listdir(target_dir):
        src = os.path.join(target_dir, fname)
        if not os.path.isfile(src):
            continue

        m = DATE_PATTERN.match(fname)
        if not m:
            continue

        date_str = m.group(1)
        date_dir = os.path.join(target_dir, date_str)
        os.makedirs(date_dir, exist_ok=True)

        dst = os.path.join(date_dir, fname)
        shutil.move(src, dst)
        print(f'  {fname} -> {date_str}/')
        moved += 1

    print(f'\n整理完成，共移动 {moved} 个文件')

if __name__ == '__main__':
    organize_by_date()
