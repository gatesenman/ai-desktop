import fsp from 'node:fs/promises';
import path from 'node:path';

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html', '.htm', '.ini', '.yaml', '.yml', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.sql', '.bat', '.ps1', '.sh']);
export const SUMMARIZABLE = new Set([...TEXT_EXT, '.pdf', '.docx']);

export function canSummarize(p: string): boolean {
  return SUMMARIZABLE.has(path.extname(p).toLowerCase());
}

function decodeText(buf: Buffer): string {
  // UTF-8 with BOM / UTF-16LE BOM; fall back to GBK (common for Chinese Windows files)
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad > 5) {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      /* ignore */
    }
  }
  return utf8.replace(/^\uFEFF/, '');
}

export async function extractText(p: string, maxChars = 15000): Promise<{ text: string; truncated: boolean }> {
  const ext = path.extname(p).toLowerCase();
  const st = await fsp.stat(p);
  if (st.size > 50 * 1024 * 1024) throw new Error('文件过大（>50MB），暂不支持总结');
  let text = '';
  if (ext === '.pdf') {
    // require lib directly to avoid pdf-parse's debug-mode entry point
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const buf = await fsp.readFile(p);
    // pdf.js prints a lot of font warnings via console.log; silence them while parsing
    const { log, warn } = console;
    console.log = console.warn = () => {};
    try {
      const data = await pdfParse(buf);
      text = data.text || '';
    } finally {
      console.log = log;
      console.warn = warn;
    }
  } else if (ext === '.docx') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ path: p });
    text = r.value || '';
  } else if (TEXT_EXT.has(ext)) {
    text = decodeText(await fsp.readFile(p));
  } else {
    throw new Error('暂不支持该文件类型（支持 txt/md/csv/代码/pdf/docx）');
  }
  text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('未能从文件中提取到文本（可能是扫描版 PDF）');
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated };
}
