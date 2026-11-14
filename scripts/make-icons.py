"""Regenerate the app icons from the official dragon artwork.

    python3 scripts/make-icons.py assets/brand/jarvis-dragon-original.webp web/public

Crops the rounded-square icon, removes the black outer corners (transparent),
and writes dragon-1024.webp plus PNG icons. Requires Pillow.
"""
import sys
from PIL import Image, ImageDraw

src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGBA')
box = (58, 46, 1196, 1202)  # bounds of the rounded square in the 1254x1254 source
S = 4  # supersampling for a smooth mask edge
mask = Image.new('L', (im.width * S, im.height * S), 0)
ImageDraw.Draw(mask).rounded_rectangle([c * S for c in box], radius=248 * S, fill=255)
im.putalpha(mask.resize(im.size, Image.LANCZOS))
crop = im.crop(box)
side = max(crop.size)
canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
canvas.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
canvas.resize((1024, 1024), Image.LANCZOS).save(f'{out}/dragon-1024.webp', quality=90)
for s in (512, 192, 180, 64, 32):
    canvas.resize((s, s), Image.LANCZOS).save(f'{out}/icon-{s}.png', optimize=True)
print('icons written to', out)
