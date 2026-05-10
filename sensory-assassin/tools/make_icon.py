"""感官刺客 — Chrome extension icon generator.

The visual language follows the sibling Minimal Reader icon: white rounded
square, crisp edges, and a single saturated blue-purple mark.
"""
from PIL import Image
from PIL import ImageDraw
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BLUE = (19, 3, 252, 255)  # Match Minimal Reader.
WHITE = (255, 255, 255, 255)


def make_icon(size: int) -> Image.Image:
    scale = size / 128
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def p(value: int) -> int:
        return round(value * scale)

    draw.rounded_rectangle(
        [p(8), p(8), p(120), p(120)],
        radius=p(24),
        fill=WHITE,
    )

    draw.polygon(
        [
            (p(22), p(64)), (p(38), p(42)), (p(64), p(30)), (p(90), p(42)),
            (p(106), p(64)), (p(90), p(86)), (p(64), p(98)), (p(38), p(86)),
        ],
        fill=BLUE,
    )
    draw.polygon(
        [
            (p(38), p(64)), (p(50), p(52)), (p(64), p(46)), (p(78), p(52)),
            (p(90), p(64)), (p(78), p(76)), (p(64), p(82)), (p(50), p(76)),
        ],
        fill=WHITE,
    )
    draw.rectangle([p(58), p(58), p(70), p(70)], fill=BLUE)
    draw.polygon(
        [(p(82), p(24)), (p(100), p(24)), (p(48), p(104)), (p(30), p(104))],
        fill=BLUE,
    )
    return img


for s in (16, 32, 48, 128):
    make_icon(s).save(OUT / f"icon-{s}.png")

print("done ->", OUT)
for p in sorted(OUT.glob("icon-*.png")):
    print(" ", p.name, p.stat().st_size, "bytes")
