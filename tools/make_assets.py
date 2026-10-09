#!/usr/bin/env python3
"""Generate the Findus poster-style SVG assets (starburst + ball mark)."""
import math, os

OUT = os.path.dirname(os.path.abspath(__file__))
PINK, YELLOW, ORANGE, GREEN, BLUE = "#ee7c9c", "#f5c33b", "#e4532b", "#12924b", "#3b9bd8"
PAPER, INK = "#f1ebd9", "#141110"
COLOURS = [PINK, YELLOW, GREEN, BLUE, ORANGE]
ORDER = [0, 3, 1, 4, 2]  # pink, blue, yellow, orange, green - spreads adjacent hues


def spike(cx, cy, angle_deg, reach, half_width):
    a = math.radians(angle_deg)
    ax, ay = cx + reach * math.cos(a), cy + reach * math.sin(a)
    px, py = -math.sin(a) * half_width, math.cos(a) * half_width
    return "M%.1f %.1f L%.1f %.1f L%.1f %.1f Z" % (ax, ay, cx + px, cy + py, cx - px, cy - py)


def star(cx, cy, outer, inner, points=5, rotate=-90):
    pts = []
    for i in range(points * 2):
        r = outer if i % 2 == 0 else inner
        a = math.radians(rotate + i * (360 / (points * 2)))
        pts.append("%.1f,%.1f" % (cx + r * math.cos(a), cy + r * math.sin(a)))
    return "M" + " L".join(pts) + " Z"


def burst(cx, cy, count, reaches, half_width, offset=0):
    out = []
    for i in range(count):
        reach = reaches[i % len(reaches)]
        colour = COLOURS[(i + offset) % len(COLOURS)]
        angle = 360 / count * i
        out.append('<path d="%s" fill="%s"/>' % (spike(cx, cy, angle, reach, half_width), colour))
    return "\n    ".join(out)


# --- burst.svg : decorative starburst used behind the header wordmark ---------
burst_paths = burst(100, 100, 16, [98, 70, 88, 62], 11, offset=0)
burst_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="presentation" aria-hidden="true">
  <g>
    %s
  </g>
</svg>
''' % burst_paths

# --- findus-mark.svg : app icon / brand mark (ball + star on a burst) --------
mark_burst = burst(90, 90, 12, [80, 62], 12, offset=2)
mark_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" role="img" aria-label="Findus Premier League">
  <rect width="180" height="180" fill="%s"/>
  <g>
    %s
  </g>
  <circle cx="90" cy="90" r="37" fill="%s" stroke="%s" stroke-width="5"/>
  <path d="%s" fill="%s"/>
</svg>
''' % (PAPER, mark_burst, PAPER, INK, star(90, 90, 26, 10.5), INK)

# --- icon.svg : compact favicon / crest fallback -----------------------------
icon_burst = burst(90, 90, 10, [82, 64], 13, offset=4)
icon_svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" role="img" aria-label="Football fixtures icon">
  <rect width="180" height="180" fill="%s"/>
  <g>
    %s
  </g>
  <circle cx="90" cy="90" r="40" fill="%s" stroke="%s" stroke-width="5"/>
  <path d="%s" fill="%s"/>
</svg>
''' % (PAPER, icon_burst, PAPER, INK, star(90, 90, 28, 11.5), INK)

for name, content in [("burst.svg", burst_svg), ("findus-mark.svg", mark_svg), ("icon.svg", icon_svg)]:
    path = os.path.join(OUT, name)
    with open(path, "w") as fh:
        fh.write(content)
    print("wrote %s (%d bytes)" % (path, len(content)))
