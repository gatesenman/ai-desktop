"""Fail if any emoji / pictographic codepoint appears in the UI sources (icon font only)."""
import os, re, sys
EMOJI = re.compile('[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF\U0001F900-\U0001F9FF\uFE0F\u200D\u2300-\u23FF\u25A0-\u25FF\u2190-\u21FF]')
roots = ['src', 'static', 'scripts', 'README.md']
bad = 0
for r in roots:
    paths = [r] if os.path.isfile(r) else [os.path.join(d, f) for d, _, fs in os.walk(r) for f in fs]
    for p in paths:
        if not p.endswith(('.ts', '.html', '.css', '.md', '.mjs', '.py', '.json')):
            continue
        for i, line in enumerate(open(p, encoding='utf-8'), 1):
            for m in EMOJI.finditer(line):
                if p.endswith('check-emoji.py'):
                    continue
                bad += 1
                print(f'{p}:{i}: U+{ord(m.group()):04X} {line.strip()[:80]}')
print(f'emoji/pictograph codepoints found: {bad}')
sys.exit(1 if bad else 0)
