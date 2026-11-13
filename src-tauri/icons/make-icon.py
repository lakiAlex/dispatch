"""Renders AppIcon.icon/Assets/background.png: two white server units stacked on a dark graphite
background, each with a drive slot and vents, a soft shadow and a light bevel.
The image is a full square; macOS rounds the corners.

Usage: python3 make-icon.py [out.png]   (needs Pillow, so not with -I)
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersampling for the shapes
RADIUS = SIZE * 0.2237  # corner radius of the system mask, used for the rim

GRAPHITE = ((0x26, 0x27, 0x2B), (0x0E, 0x0E, 0x10))
BODY = ((0xFF, 0xFF, 0xFF), (0xDD, 0xDF, 0xE3))
SLOT = ((0xC4, 0xC7, 0xCD), (0x8E, 0x92, 0x99))
UNITS = (250, 530)  # top edge of each unit; both are 584 x 244 px


def ss_mask(draw_fn):
    m = Image.new("L", (SIZE * SS, SIZE * SS), 0)
    draw_fn(ImageDraw.Draw(m), SS)
    return m.resize((SIZE, SIZE), Image.LANCZOS)


def linear(c0, c1, angle=90):
    """Linear gradient from c0 to c1; angle 90 runs top to bottom."""
    # A rotated square of side 364 still covers its central 256 square at any angle.
    g = Image.linear_gradient("L").resize((364, 364), Image.BICUBIC).rotate(90 - angle, resample=Image.BICUBIC)
    g = g.crop((54, 54, 310, 310)).resize((SIZE, SIZE), Image.BICUBIC)
    return Image.composite(Image.new("RGB", (SIZE, SIZE), c1), Image.new("RGB", (SIZE, SIZE), c0), g)


def layer(color, mask, opacity=1.0):
    l = Image.new("RGBA", (SIZE, SIZE), color)
    l.putalpha(mask.point(lambda v: round(v * opacity)))
    return l


def fill(img, colors, mask, angle=70):
    g = linear(*colors, angle).convert("RGBA")
    g.putalpha(mask)
    img.alpha_composite(g)


def rr(x0, y0, x1, y1, r):
    return ss_mask(lambda d, s: d.rounded_rectangle((x0 * s, y0 * s, x1 * s, y1 * s), r * s, fill=255))


def sunk(img, mask, colors):
    """A recessed area: filled, with a shadow along its top edge."""
    fill(img, colors, mask)
    img.alpha_composite(layer((0, 0, 0), ImageChops.subtract(mask, ImageChops.offset(mask, 0, -4)).filter(ImageFilter.GaussianBlur(2)), 0.2))


def main(out):
    img = linear(*GRAPHITE).convert("RGBA")

    for top in UNITS:
        unit = rr(220, top, 804, top + 244, 48)
        # Soft shadow, body, and a bevel: lit top edge, darker bottom edge.
        img.alpha_composite(layer((0, 0, 0), ImageChops.offset(unit, 0, 16).filter(ImageFilter.GaussianBlur(22)), 0.6))
        fill(img, BODY, unit)
        lit = ImageChops.subtract(unit, ImageChops.offset(unit, 0, 5)).filter(ImageFilter.GaussianBlur(2))
        shade = ImageChops.subtract(unit, ImageChops.offset(unit, 0, -5)).filter(ImageFilter.GaussianBlur(3))
        img.alpha_composite(layer((255, 255, 255), lit, 0.5))
        img.alpha_composite(layer((0, 0, 0), shade, 0.25))
        # Drive slot on the left, four vents on the right.
        sunk(img, rr(300, top + 92, 560, top + 152, 18), SLOT)
        for k in range(4):
            x = 620 + k * 32
            sunk(img, rr(x, top + 84, x + 14, top + 160, 7), SLOT)

    # Soft highlight at the top and a faint rim along the system mask.
    hl = linear((255, 255, 255), (0, 0, 0)).convert("L").point(lambda v: max(0, v - 170) * 2)
    img.alpha_composite(layer((255, 255, 255), hl, 0.10))
    rim = ss_mask(lambda d, s: d.rounded_rectangle((2 * s, 2 * s, (SIZE - 2) * s, (SIZE - 2) * s), (RADIUS - 2) * s, outline=255, width=3 * s))
    img.alpha_composite(layer((255, 255, 255), ImageChops.multiply(rim, linear((255,) * 3, (30,) * 3).convert("L")), 0.25))

    img.convert("RGB").save(out)
    print("wrote", out)


main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "AppIcon.icon", "Assets", "background.png"))
