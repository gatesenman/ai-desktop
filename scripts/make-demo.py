"""Create a realistic demo desktop for screenshots / manual testing.
usage: python3 scripts/make-demo.py [/tmp/fdesk] [/tmp/fdesk-portal]"""
import os, sys, time, shutil
D = sys.argv[1] if len(sys.argv) > 1 else '/tmp/fdesk'
P = sys.argv[2] if len(sys.argv) > 2 else '/tmp/fdesk-portal'
for d in (D, P):
    shutil.rmtree(d, ignore_errors=True)
    os.makedirs(d)
now = time.time()
DAY = 86400
def mk(path, size=2048, age_days=0.0, content=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        if content is not None:
            f.write(content.encode('utf-8') if isinstance(content, str) else content)
        elif size > 50_000_000:
            f.truncate(size)  # sparse
        else:
            f.write(os.urandom(min(size, 4096)) * (size // 4096) + os.urandom(size % 4096))
    t = now - age_days * DAY
    os.utime(path, (t, t))

def pdf_bytes(lines):
    """Minimal valid single-page PDF with Helvetica text (ASCII)."""
    body = 'BT /F1 14 Tf 72 760 Td 18 TL ' + ' '.join('(%s) Tj T*' % l.replace('(', '[').replace(')', ']') for l in lines) + ' ET'
    objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
            '<< /Length %d >>\nstream\n%s\nendstream' % (len(body), body), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    out = '%PDF-1.4\n'; offs = []
    for i, o in enumerate(objs):
        offs.append(len(out)); out += '%d 0 obj\n%s\nendobj\n' % (i + 1, o)
    x = len(out)
    out += 'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + ''.join('%010d 00000 n \n' % o for o in offs)
    out += 'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%EOF\n' % (len(objs) + 1, x)
    return out.encode('latin-1')
def docx_bytes(paras):
    import io, zipfile
    from xml.sax.saxutils import escape
    b = io.BytesIO(); z = zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED)
    z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join('<w:p><w:r><w:t>%s</w:t></w:r></w:p>' % escape(t) for t in paras) + '</w:body></w:document>')
    z.close(); return b.getvalue()
def chrome_pdf(path, lines):
    import subprocess, tempfile, html
    chrome = shutil.which('google-chrome') or shutil.which('chromium')
    if not chrome: return False
    h = tempfile.NamedTemporaryFile('w', suffix='.html', delete=False, encoding='utf-8')
    h.write('<meta charset=utf-8><body style="font-family:sans-serif">' + ''.join('<p>%s</p>' % html.escape(l) for l in lines)); h.close()
    out = path + '.tmp.pdf'
    subprocess.run([chrome, '--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', '--print-to-pdf=' + out, h.name], capture_output=True, timeout=120)
    if os.path.exists(out) and os.path.getsize(out) > 500:
        real(path, open(out, 'rb').read()); os.remove(out); return True
    return False
def real(path, data):
    t = os.stat(path).st_mtime
    open(path, 'wb').write(data); os.utime(path, (t, t))
apps = ['微信', 'Chrome', 'VSCode', '钉钉', '网易云音乐', 'Steam', 'QQ', 'Edge']
for i, a in enumerate(apps): mk(f'{D}/{a}.lnk', 1200, 30 + i)
# keep the "上周的那个报价PDF" demo query deterministic whatever weekday it is: put it mid last week
import datetime as _dt
_n = _dt.datetime.now()
LAST_WEEK = _n.weekday() + (_n.hour * 3600 + _n.minute * 60) / DAY + 3.5
docs = {
    '报价单_华东客户_v2.pdf': (196_000, LAST_WEEK), 'Q3 Quote - ACME.pdf': (188_000, 1.2), '项目周报.docx': (24_000, 0.1),
    '年度预算.xlsx': (41_000, 2.5), '会议纪要.txt': (3_200, 0.05), '需求文档.pdf': (312_000, 5), '产品路线图.pptx': (2_400_000, 3),
    'readme.md': (900, 8),
}
for n, (sz, age) in docs.items(): mk(f'{D}/{n}', sz, age)
mk(f'{D}/会议纪要.txt', age_days=0.05, content='10月10日 产品周会\n1. 发布 1.2 版本：Fences 风格格子、整理规则、AI 工作台\n2. 下周一前完成 Windows 安装包测试\n3. 待办：张三 更新报价单；李四 联系华东客户确认合同\n')
mk(f'{D}/发票_滴滴出行_0923.pdf', 86_000, 9)
mk(f'{D}/发票_京东_笔记本电脑.pdf', 120_000, 14)
mk(f'{D}/报销单_9月.xlsx', 18_000, 6)
mk(f'{D}/截图 2026-10-08 101522.png', 420_000, 2)
mk(f'{D}/屏幕截图 2026-10-09 153010.png', 380_000, 1)
mk(f'{D}/Snipaste_2026-10-10_09-12-33.png', 260_000, 0.03)
mk(f'{D}/产品海报.psd', 38_000_000, 4)
mk(f'{D}/团队合影.jpg', 3_100_000, 20)
mk(f'{D}/演示视频.mp4', 46_000_000, 7)
mk(f'{D}/会议录屏_完整版.mp4', 1_288_000_000, 33)
mk(f'{D}/资料备份.zip', 12_000_000, 60)
mk(f'{D}/素材包.7z', 8_400_000, 18)
mk(f'{D}/WeChatSetup.exe', 4_500_000, 21)
mk(f'{D}/VSCodeUserSetup-x64.exe', 3_900_000, 45)
mk(f'{D}/旧版报价_2025.doc', 52_000, 230)
mk(f'{D}/临时笔记.txt', 600, 140, content='临时笔记：周五前提交发票报销')
# duplicates (identical bytes)
shutil.copy2(f'{D}/需求文档.pdf', f'{D}/需求文档 (1).pdf')
shutil.copy2(f'{D}/团队合影.jpg', f'{D}/团队合影 - 副本.jpg')
mk(f'{D}/工作资料/合同_华东客户.pdf', 140_000, 12)
mk(f'{D}/工作资料/合同_报价附件.pdf', 90_000, 12)
os.makedirs(f'{D}/照片'); os.makedirs(f'{D}/空文件夹')
# portal (e.g. Downloads)
mk(f'{P}/下载/文档/用户手册.pdf', 820_000, 3)
mk(f'{P}/下载/文档/接口说明.docx', 64_000, 6)
mk(f'{P}/下载/图片/壁纸_极光.jpg', 2_600_000, 2)
mk(f'{P}/下载/图片/图标素材.png', 120_000, 9)
mk(f'{P}/下载/Python-3.13.0-amd64.exe', 26_000_000, 11)
mk(f'{P}/下载/数据导出_2026Q3.csv', 340_000, 1)
mk(f'{P}/下载/会议邀请.ics', 1_200, 0.2)
mk(f'{P}/下载/开源协议.txt', 11_000, 40)
for fn, lines in {'Q3 Quote - ACME.pdf': ['Quotation - ACME East China Branch 报价单', '总价 Total: 128,000 CNY（含税）', '有效期至下月底', '交付周期：合同签订后 30 天'],
                  '需求文档.pdf': ['需求文档 v1.3', '桌面整理工具：AI 分组与整理规则', '交付周期：6 周']}.items():
    if not chrome_pdf(f'{D}/{fn}', lines): real(f'{D}/{fn}', pdf_bytes(lines[:1]))
shutil.copy2(f'{D}/需求文档.pdf', f'{D}/需求文档 (1).pdf')
real(f'{D}/项目周报.docx', docx_bytes(['项目周报（第 41 周）', '本周完成：报价单 v2 发给华东客户，合同条款确认。', '下周计划：完成 Windows 安装包测试，跟进客户交付周期。']))
real(f'{P}/下载/文档/接口说明.docx', docx_bytes(['接口说明', '所有接口均返回 JSON。']))
print('ok', D, P)
