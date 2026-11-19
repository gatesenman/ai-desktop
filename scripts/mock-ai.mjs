// Minimal OpenAI-compatible mock server for local testing: node scripts/mock-ai.mjs [port]
import http from 'node:http';
const port = Number(process.argv[2] || 8787);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const sys = j.messages?.[0]?.content ?? '';
    const user = j.messages?.[j.messages.length - 1]?.content ?? '';
    let reply = '你好！我是模拟的 AI 助手（mock）。';
    if (user.includes('PowerShell')) reply = '可以用下面的脚本，按「年-月」把桌面截图归档到 `桌面\\截图归档` 中：\n\n```powershell\n$desk = [Environment]::GetFolderPath(\'Desktop\')\n$dest = Join-Path $desk \'截图归档\'\nGet-ChildItem $desk -Filter *.png | ForEach-Object {\n  $dir = Join-Path $dest $_.LastWriteTime.ToString(\'yyyy-MM\')\n  New-Item $dir -ItemType Directory -Force | Out-Null\n  Move-Item $_.FullName $dir\n}\n```\n\n**提示**：先把 `Move-Item` 换成 `Copy-Item` 试运行一次，确认无误后再移动。';
    else if (user.includes('-----文件内容开始-----')) reply = '**一句话概括**：这是一份给 ACME 华东分公司的报价单。\n\n**要点总结**\n- 总价 **128,000 元**（含税）\n- 有效期至下月底\n- 交付周期 30 天\n\n**关键信息**\n1. 客户：ACME 华东分公司\n2. 待办：月底前跟进客户确认';
    if (sys.includes('桌面整理助手')) {
      const list = JSON.parse(user);
      const g = { 工作文档: [], 常用软件: [], 媒体素材: [] };
      for (const f of list) (f.t === '程序/快捷方式' ? g.常用软件 : ['图片', '视频', '音频'].includes(f.t) ? g.媒体素材 : g.工作文档).push(f.i);
      reply = '```json\n' + JSON.stringify({ groups: Object.entries(g).map(([name, items]) => ({ name, items })) }) + '\n```';
    } else if (sys.includes('文件查找助手')) {
      const lines = user.split('\n').slice(2);
      const m = lines.map((l) => l.split('\t')).filter((c) => /quote|报价/i.test(c[1]) && /pdf/i.test(c[1]) && c[3]?.startsWith('2026-10-0'));
      reply = JSON.stringify({ matches: m.map((c) => ({ id: Number(c[0]), reason: '文件名含报价/Quote，且为上周修改的 PDF' })) });
    }

    // ---- v1.2 AI features
    if (sys.includes('桌面整理助手') && sys.includes('reason')) {
      const list = JSON.parse(user);
      const defs = [
        ['ACME 项目', 'ri-briefcase-4-line', '报价、合同和需求都属于 ACME 客户项目', /acme|报价|合同|需求|quote/i],
        ['财务报销', 'ri-money-cny-circle-line', '发票和报销单，月底集中提交', /发票|报销|收据|invoice/i],
        ['安装包', 'ri-install-line', '装完即可删除的安装程序', /setup|安装|\.msi|installer/i],
        ['学习资料', 'ri-book-open-line', '教程、笔记和课程，空闲时阅读', /教程|笔记|课程|学习|读书|notes/i],
        ['设计素材', 'ri-palette-line', '截图、设计稿和图片素材', /截图|设计|\.psd|海报|logo|png|jpg/i],
        ['常用软件', 'ri-apps-2-line', '每天都会打开的程序快捷方式', null],
      ];
      const g = defs.map((d) => ({ name: d[0], icon: d[1], reason: d[2], items: [] }));
      const other = { name: '其他文档', icon: 'ri-folder-3-line', reason: '暂时无法归类的文件', items: [] };
      for (const f of list) {
        const k = f.t === '程序/快捷方式' ? 5 : defs.findIndex((d) => d[3] && d[3].test(f.n));
        (k >= 0 ? g[k] : other).items.push(f.i);
      }
      reply = JSON.stringify({ groups: [...g, other].filter((x) => x.items.length) });
    } else if (sys.includes('文件命名助手')) {
      const list = JSON.parse(user);
      reply = JSON.stringify({ items: list.map((f) => {
        const m = f.n.match(/^(.*?)(\.[^.]+)?$/);
        let base = m[1].replace(/\s*[（(]\d+[)）]|\s*-\s*副本|副本|最终版|final|新建|_+$/gi, '').replace(/^(IMG|微信图片|mmexport)_?\d*/i, '照片').replace(/[_\s]+/g, '_').replace(/^_|_$/g, '') || '文件';
        const date = (f.n.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/) || []).slice(1).join('-') || f.date;
        base = base.replace(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})_?/, '');
        return { i: f.i, name: `${date}_${base}${m[2] || ''}`, reason: /照片/.test(base) ? '识别为照片，按日期命名' : /副本|\(|（/.test(f.n) ? '去掉副本/编号噪声' : '补充日期前缀' };
      }) });
    } else if (sys.includes('今日桌面简报')) {
      reply = '今天主要在推进 **ACME 项目**：报价单和合同都有更新，建议下班前把两份文件放进同一个格子。\n\n- 桌面上有 **3 份重复文件** 和多个装过的安装包，清理后可释放约 1 GB\n- 「需求说明」已 2 周没动，记得和客户确认\n- 月底前别忘了提交 **发票报销**';
    } else if (sys.includes('转换成桌面整理规则')) {
      reply = JSON.stringify({ name: '发票归入财务', match: 'any', conds: [{ field: 'name', op: 'contains', value: '发票|invoice|报销' }, { field: 'ext', op: 'in', value: '.ofd' }], target: '财务票据', icon: 'ri-money-cny-circle-line' });
    } else if (sys.includes('命令解析器')) {
      const t = user;
      const actions = [];
      if (/发票/.test(t)) actions.push({ type: 'create-rule', label: '', rule: { name: '发票归入财务', match: 'any', conds: [{ field: 'name', op: 'contains', value: '发票|invoice|报销' }], target: '财务票据' } }, { type: 'move', query: '发票', box: '财务票据', label: '把桌面上现有的 3 张发票放进「财务票据」' });
      if (/整理/.test(t) && !actions.length) actions.push({ type: 'organize', label: '按规则和类型整理桌面' });
      if (/快照|保存/.test(t)) actions.push({ type: 'snapshot-save', name: '整理后', label: '保存当前布局为快照「整理后」' });
      if (!actions.length) actions.push({ type: 'search', query: t, label: '搜索 ' + t });
      reply = JSON.stringify({ actions, reply: '好的，以后新的发票也会自动归入「财务票据」。' });
    }
    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const ch of reply.match(/.{1,4}/gsu) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
    }
  });
}).listen(port, () => console.log('mock AI on http://127.0.0.1:' + port + '/v1'));
