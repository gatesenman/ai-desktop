"""Compose per-window captures (from `electron . --capture=<dir>`) onto a generated wallpaper.
Xvfb has no compositor, so transparent windows render on black when grabbing the X screen; capturing each
window's page with alpha and compositing gives an accurate picture of what Windows would show.
usage: python3 compose-shot.py <capture_dir> <out.png> [--crop=name] [--margin=48]"""
import json, sys, math
from PIL import Image, ImageDraw, ImageFilter

cap, out = sys.argv[1], sys.argv[2]
opts = dict(a[2:].split('=', 1) for a in sys.argv[3:] if a.startswith('--') and '=' in a)
m = json.load(open(f'{cap}/manifest.json'))
W, H = m['screen']['width'], m['screen']['height']
dark = m['theme'] == 'dark'

def wallpaper(w, h, dark):
    import numpy as np
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    nx, ny = x / w, y / h
    if dark:
        base = np.array([12, 16, 34], np.float32)
        blobs = [((0.78, 0.30), 0.55, (40, 90, 210)), ((0.25, 0.85), 0.55, (90, 50, 180)), ((0.55, 0.65), 0.35, (20, 140, 190))]
    else:
        base = np.array([214, 226, 245], np.float32)
        blobs = [((0.80, 0.30), 0.55, (150, 190, 255)), ((0.20, 0.85), 0.55, (200, 180, 250)), ((0.55, 0.60), 0.35, (160, 225, 240))]
    img = np.broadcast_to(base, (h, w, 3)).copy()
    for (cx, cy), r, col in blobs:
        d = np.sqrt(((nx - cx) * (w / h)) ** 2 + (ny - cy) ** 2)
        a = np.clip(1 - d / r, 0, 1) ** 2
        img = img * (1 - a[..., None] * 0.85) + np.array(col, np.float32) * (a[..., None] * 0.85)
    # soft diagonal ribbon (Win11 bloom-ish)
    rib = np.exp(-(((ny - 0.55) - (nx - 0.5) * 0.6) ** 2) / 0.012)
    img = img + (np.array([255, 255, 255], np.float32) - img) * (rib[..., None] * (0.10 if dark else 0.25))
    return Image.fromarray(np.clip(img, 0, 255).astype('uint8'), 'RGB').convert('RGBA')

bg = wallpaper(W, H, dark)

def shadow(size, radius=10, blur=22, alpha=110, offset=(0, 10)):
    w, h = size
    pad = blur * 3
    sh = Image.new('RGBA', (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle([pad, pad, pad + w, pad + h], radius=radius, fill=(0, 0, 0, alpha))
    return sh.filter(ImageFilter.GaussianBlur(blur)), pad, offset

for win in m['windows']:
    im = Image.open(win['file']).convert('RGBA')
    if im.size != (win['width'], win['height']):
        im = im.resize((win['width'], win['height']), Image.LANCZOS)
    x, y = win['x'], win['y']
    if win['opaque']:
        # Windows 11 gives frameless opaque windows rounded corners + a shadow
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=8, fill=255)
        im.putalpha(mask)
        sh, pad, (ox, oy) = shadow(im.size, 8, 24, 120 if dark else 70)
        bg.alpha_composite(sh, (max(0, x - pad + ox), max(0, y - pad + oy)))
        border = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(border).rounded_rectangle([0, 0, im.size[0] - 1, im.size[1] - 1], radius=8, outline=(255, 255, 255, 28) if dark else (0, 0, 0, 30))
        im.alpha_composite(border)
    elif win['name'].startswith('fence'):
        sh, pad, (ox, oy) = shadow(im.size, 12, 14, 70 if dark else 35, (0, 4))
        bg.alpha_composite(sh, (max(0, x - pad + ox), max(0, y - pad + oy)))
    bg.alpha_composite(im, (x, y))

crop = opts.get('crop')
if crop:
    mg = int(opts.get('margin', 48))
    ws = [w for w in m['windows'] if w['name'] == crop]
    if ws:
        w = ws[0]
        box = (max(0, w['x'] - mg), max(0, w['y'] - mg), min(W, w['x'] + w['width'] + mg), min(H, w['y'] + w['height'] + mg))
        bg = bg.crop(box)
bg.convert('RGB').save(out, optimize=True)
print('saved', out, bg.size)
