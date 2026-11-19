"""Split a file into <24MB parts + Windows join script + checksums.
usage: split-parts.py <file> <outdir> [partMB]"""
import hashlib, os, sys
src, out = sys.argv[1], sys.argv[2]
size = int(float(sys.argv[3]) * 1024 * 1024) if len(sys.argv) > 3 else 23 * 1024 * 1024
os.makedirs(out, exist_ok=True)
for f in os.listdir(out): os.remove(os.path.join(out, f))
name = os.path.basename(src)
full = hashlib.sha256(open(src, 'rb').read()).hexdigest()
parts = []
with open(src, 'rb') as fh:
    i = 1
    while True:
        b = fh.read(size)
        if not b: break
        p = f'{name}.{i:03d}'
        open(os.path.join(out, p), 'wb').write(b)
        parts.append((p, len(b), hashlib.sha256(b).hexdigest()))
        i += 1
plus = '+'.join(f'"{p}"' for p, _, _ in parts)
bat = f'''@echo off\r
chcp 65001 >nul\r
cd /d "%~dp0"\r
echo 正在合并 {len(parts)} 个分卷...\r
copy /b {plus} "{name}" >nul\r
if errorlevel 1 (echo 合并失败，请确认所有分卷都在同一文件夹中。& pause & exit /b 1)\r
echo 正在校验 SHA-256...\r
certutil -hashfile "{name}" SHA256 | findstr /i "{full}" >nul\r
if errorlevel 1 (echo 校验失败：文件不完整或已损坏。& pause & exit /b 1)\r
echo 完成：{name}\r
pause\r
'''
open(os.path.join(out, '合并分卷.bat'), 'w', encoding='utf-8', newline='').write(bat)
lines = [f'{h}  {p}' for p, _, h in parts] + [f'{full}  {name}']
open(os.path.join(out, 'SHA256SUMS.txt'), 'w', newline='\n').write('\n'.join(lines) + '\n')
readme = f'''AI 桌面整理 - 安装包分卷说明\r
==============================\r
\r
原文件：{name}（{os.path.getsize(src)} 字节）\r
SHA-256：{full}\r
分卷：{len(parts)} 个，每个小于 24 MB：\r
''' + ''.join(f'  {p}  {n} 字节\r\n' for p, n, _ in parts) + f'''\r
合并方法（Windows）：\r
  1. 把所有 {name}.0xx 分卷、合并分卷.bat 放进同一个文件夹；\r
  2. 双击「合并分卷.bat」，会生成 {name} 并自动校验 SHA-256；\r
  3. 双击 {name} 安装。\r
\r
手动合并（命令提示符 cmd）：\r
  copy /b {plus} "{name}"\r
  certutil -hashfile "{name}" SHA256\r
\r
PowerShell：\r
  Get-Content {",".join(p for p,_,_ in parts)} -Encoding Byte -ReadCount 0 | Set-Content "{name}" -Encoding Byte   (Windows PowerShell 5.1)\r
  或在 PowerShell 7 中：cmd /c copy /b {plus} "{name}"\r
\r
Linux / macOS：\r
  cat {name}.0* > "{name}" && sha256sum "{name}"\r
'''
open(os.path.join(out, 'README-合并说明.txt'), 'w', encoding='utf-8-sig', newline='').write(readme)
for p, n, _ in parts: print(p, n)
