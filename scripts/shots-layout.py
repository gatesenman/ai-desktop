"""Write curated layout/settings for the screenshot scenes into /tmp/shots/ud-<scene>."""
import json, os, uuid, sys
D = '/tmp/fdesk'; P = '/tmp/fdesk-portal/下载'
f = lambda n: os.path.join(D, n)
def box(title, x, y, w, h, items=(), color='', icon='ri-inbox-2-line', cat=None, **kw):
    b = dict(id=str(uuid.uuid4()), title=title, category=cat, x=x, y=y, w=w, h=h, collapsed=False, items=[f(i) for i in items],
             color=color, icon=icon, view='grid', sort='manual', kind='normal', page=0, titleStyle='band', titleAlign='center', tint=0.35)
    b.update(kw); return b
R = 1600 - 16 - 360
boxes = [
    box('常用软件', 16, 16, 360, 206, ['微信.lnk', 'Chrome.lnk', 'VSCode.lnk', '钉钉.lnk', '网易云音乐.lnk', 'Steam.lnk', 'QQ.lnk', 'Edge.lnk'], '#2f9bff', 'ri-apps-2-line', 'program', tint=0.25),
    box('工作文档', 16, 230, 360, 300, ['报价单_华东客户_v2.pdf', 'Q3 Quote - ACME.pdf', '项目周报.docx', '年度预算.xlsx', '会议纪要.txt', '需求文档.pdf', '需求文档 (1).pdf', '产品路线图.pptx', 'readme.md', '旧版报价_2025.doc', '临时笔记.txt'], '#4f7cff', 'ri-briefcase-4-line', 'doc', view='list', sort='date', tint=0.3),
    box('财务票据', 16, 538, 360, 150, ['发票_滴滴出行_0923.pdf', '发票_京东_笔记本电脑.pdf', '报销单_9月.xlsx'], '#e8a92c', 'ri-money-cny-circle-line', titleStyle='accent', tint=0.3),
    box('截图', 16, 696, 360, 170, ['截图 2026-10-08 101522.png', '屏幕截图 2026-10-09 153010.png', 'Snipaste_2026-10-10_09-12-33.png'], '#14b8a6', 'ri-screenshot-2-line', tint=0.3),
    box('最近文件', R, 16, 360, 268, [], '#9b6bff', 'ri-time-line', view='list', sort='date', kind='recent', tint=0.28),
    box('下载', R, 292, 360, 248, [], '#e8a92c', 'ri-folder-open-line', kind='portal', portal={'root': P, 'cwd': P}, tint=0.2),
    box('设计与媒体', R, 548, 360, 170, ['产品海报.psd', '团队合影.jpg', '团队合影 - 副本.jpg', '演示视频.mp4', '会议录屏_完整版.mp4'], '#e5579a', 'ri-palette-line', 'image', tint=0.3),
    box('安装包', R, 726, 360, 140, ['WeChatSetup.exe', 'VSCodeUserSetup-x64.exe'], '#f08c2e', 'ri-install-line', collapsed=True, tint=0.35),
    box('压缩包', R, 770, 360, 130, ['资料备份.zip', '素材包.7z'], '#7b8798', 'ri-file-zip-line', 'archive', collapsed=True, titleStyle='minimal', tint=0.2),
    box('文件夹', 392, 16, 300, 118, ['工作资料', '照片', '空文件夹'], '', 'ri-folder-3-line', 'folder', titleStyle='minimal'),
    # page 2
    box('游戏', 16, 16, 360, 200, [], '#3dbb63', 'ri-gamepad-line', page=1),
]
layout = dict(version=1, boxes=boxes, hidden=False, pages=['工作', '娱乐'], page=0)
rules = [
    {'id': 'r-shots', 'name': '截图集中存放', 'enabled': True, 'match': 'any', 'conds': [{'field': 'regex', 'op': 'matches', 'value': '^(截图|屏幕截图|Screenshot|Snipaste)'}], 'target': '截图', 'color': '#14b8a6', 'icon': 'ri-screenshot-2-line', 'source': 'default'},
    {'id': 'r-inv', 'name': '发票与报销', 'enabled': True, 'match': 'any', 'conds': [{'field': 'name', 'op': 'contains', 'value': '发票|invoice|报销|收据'}], 'target': '财务票据', 'color': '#e8a92c', 'icon': 'ri-money-cny-circle-line', 'source': 'ai'},
    {'id': 'r-inst', 'name': '安装包', 'enabled': True, 'match': 'any', 'conds': [{'field': 'ext', 'op': 'in', 'value': '.msi'}, {'field': 'regex', 'op': 'matches', 'value': '(setup|install|安装).*\\.exe$'}], 'target': '安装包', 'color': '#f08c2e', 'icon': 'ri-install-line', 'source': 'default'},
    {'id': 'r-psd', 'name': '.psd 放入设计与媒体', 'enabled': True, 'match': 'all', 'conds': [{'field': 'ext', 'op': 'in', 'value': '.psd,.ai,.sketch'}], 'target': '设计与媒体', 'source': 'learned'},
    {'id': 'r-old', 'name': '超过 90 天的文档待清理', 'enabled': False, 'match': 'all', 'conds': [{'field': 'category', 'op': 'is', 'value': 'doc'}, {'field': 'modified', 'op': 'older', 'value': '90'}], 'target': '待清理', 'source': 'user'},
]
scenes = sys.argv[1:] or ['fdark', 'flight', 'rules', 'ai', 'cmd', 'pages']
for sc in scenes:
    theme = 'light' if sc in ('flight', 'rules', 'pages') else 'dark'
    d = f'/tmp/shots/ud-{sc}'; os.makedirs(d, exist_ok=True)
    for x in os.listdir(d):
        if x.endswith('.json'): os.remove(os.path.join(d, x))
    json.dump(layout, open(d + '/layout.json', 'w'), ensure_ascii=False)
    st = {'theme': theme, 'onboarded': True, 'opacity': 0.5 if theme == 'dark' else 0.55, 'iconSize': 44, 'rules': rules,
          'ai': {'baseURL': 'http://127.0.0.1:8787/v1', 'apiKey': 'sk-demo-3f9a1c', 'model': 'deepseek-chat', 'temperature': 0.3}}
    json.dump(st, open(d + '/settings.json', 'w'), ensure_ascii=False)
    snaps = [{'id': 'snap-1', 'name': '工作日布局', 'at': 1791000000000, 'resolution': '1920x1080@1', 'boxes': boxes, 'pages': ['工作', '娱乐']},
             {'id': 'snap-2', 'name': '笔记本外接显示器', 'at': 1790500000000, 'resolution': '2560x1440@1.25', 'boxes': boxes, 'pages': ['工作', '娱乐']}]
    json.dump(snaps, open(d + '/snapshots.json', 'w'), ensure_ascii=False)
print('ok', scenes)
