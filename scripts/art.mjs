// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Builds the radio drawings in public/art/.
 *
 * Two radios were drawn by Joshua Murphy (ranguli, VO1RFX) in
 * https://github.com/ranguli/openrtx-device-mockups (GPL-3.0): the CS7000 and the MD-380.
 * Those are taken from his file as they are, apart from the changes listed in
 * `fromMockup`. The other radios are drawn here from the layouts in art-specs.mjs, with
 * the same shapes, colours and proportions, so the set looks like one hand drew it.
 *
 * Every radio gets two files: <id>.svg, and <id>-enter.svg with the keys that are held
 * to enter flashing mode picked out in the OpenRTX gold.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCKUPS, SPECS } from './art-specs.mjs';

/** The colours and stroke widths of the device mock-ups. */
const STYLE = {
  body: 'fill:#2c2c2c;stroke:#4f4f4f;stroke-width:11',
  panel: 'fill:#222222;stroke:#1b1b1b;stroke-width:16',
  sideKey: 'fill:#181818',
  slot: 'fill:#181818;stroke:#343434;stroke-width:2.5',
  bezel: 'fill:#272727;stroke:#0c0c0c;stroke-width:2.3',
  keyOuter: 'fill:#161616;stroke:#4f4f4f;stroke-width:3.5',
  keyInner: 'fill:#161616;stroke:#000000;stroke-width:3.2',
  knob: 'fill:#000000;stroke:#000000;stroke-width:14;stroke-linejoin:round',
  knobRib: 'stroke:#3a3a3a;stroke-width:2',
  ink: '#ffffff',
  gold: '#fab413',
  green: '#289300',
  red: '#932300',
};

/** Draws a thin grey line around whatever it is applied to. */
const RIM_FILTER =
  '<filter id="rim" x="-20%" y="-20%" width="140%" height="140%">' +
  '<feMorphology in="SourceAlpha" operator="dilate" radius="4" result="grown"/>' +
  '<feFlood flood-color="#4f4f4f"/><feComposite in2="grown" operator="in" result="edge"/>' +
  '<feMerge><feMergeNode in="edge"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';

/** Fonts with the metrics of the FreeSans the mock-ups were drawn with, on every system. */
const FONT = "FreeSans,'Liberation Sans',Arial,Helvetica,sans-serif";

const n = (value) => Number(value.toFixed(2));
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** A rounded rectangle; `mark` names it so the "enter" variant can find it. */
function rect(x, y, w, h, r, style, mark) {
  const attr = mark ? ` data-key="${mark}"` : '';
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" style="${style}"${attr}/>`;
}

/** Centred text; `size` is the font size in drawing units. */
function text(x, y, size, content, weight = 'normal') {
  return (
    `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" ` +
    `style="font-family:${FONT};font-size:${n(size)}px;font-weight:${weight};fill:${STYLE.ink}">${content}</text>`
  );
}

/** A filled triangle pointing up, down, left or right, centred on (x, y). */
function arrow(x, y, size, direction, fill = STYLE.ink) {
  const h = size * 0.9;
  const points = {
    up: [x, y - h / 2, x - size / 2, y + h / 2, x + size / 2, y + h / 2],
    down: [x, y + h / 2, x - size / 2, y - h / 2, x + size / 2, y - h / 2],
    left: [x - h / 2, y, x + h / 2, y - size / 2, x + h / 2, y + size / 2],
    right: [x + h / 2, y, x - h / 2, y - size / 2, x - h / 2, y + size / 2],
  }[direction];
  return `<polygon points="${points.map(n).join(' ')}" style="fill:${fill}"/>`;
}

/** A rotary knob standing on top of the body, ribbed, with a white pointer. */
function knob({ x, y, w, h }) {
  const ribs = [];
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;
    const rx = x + (w * i) / 8;
    ribs.push(
      `<line x1="${n(rx)}" y1="${n(y + 10)}" x2="${n(rx)}" y2="${n(y + h - 6)}" style="${STYLE.knobRib}"/>`,
    );
  }
  return (
    rect(x - 11, y - 11, w + 22, h + 22, 22, 'fill:#4f4f4f') +
    rect(x, y, w, h, 16, STYLE.knob) +
    ribs.join('') +
    rect(x + w / 2 - 5, y - 4, 10, h * 0.8, 0, `fill:${STYLE.ink}`)
  );
}

/** A stubby antenna base on top of the body. */
function antenna({ x, y, w, h }) {
  return rect(x, y, w, h, 12, 'fill:#1b1b1b;stroke:#4f4f4f;stroke-width:6');
}

/** The label of a key: a big character and, optionally, smaller letters after it. */
function keyLabel(cx, cy, key, scale) {
  const big = 42 * scale;
  if (key.icon) return keyIcon(cx, cy, key.icon, scale);
  const main = escape(key.main ?? '');
  const size = key.size ? big * key.size : big;
  if (key.glyph) {
    // A character and a small symbol side by side, as on "* lock", "0 space" and "# shift".
    return text(cx - big * 0.55, cy + size * 0.36, size, main) + glyph(cx + big * 0.5, cy, key.glyph, scale);
  }
  const sub = key.sub ? `<tspan style="font-size:${n(big * 0.72)}px"> ${escape(key.sub)}</tspan>` : '';
  return text(cx, cy + size * 0.36, size, main + sub);
}

/** The small symbols printed beside a character on some keys. */
function glyph(cx, cy, kind, scale) {
  const u = 9 * scale;
  const ink = `fill:${STYLE.ink}`;
  switch (kind) {
    case 'lock':
      return (
        `<path d="M ${n(cx - u * 0.8)} ${n(cy - u * 0.2)} v ${n(-u * 0.6)} a ${n(u * 0.8)} ${n(u * 0.8)} 0 0 1 ${n(u * 1.6)} 0 v ${n(u * 0.6)}" ` +
        `style="fill:none;stroke:${STYLE.ink};stroke-width:${n(u * 0.45)}"/>` +
        rect(cx - u * 1.3, cy - u * 0.2, u * 2.6, u * 1.9, u * 0.3, ink)
      );
    case 'space':
      return (
        rect(cx - u * 1.9, cy + u * 0.7, u * 3.8, u * 0.6, 0, ink) +
        rect(cx - u * 1.9, cy - u * 0.2, u * 0.6, u * 1.5, 0, ink) +
        rect(cx + u * 1.3, cy - u * 0.2, u * 0.6, u * 1.5, 0, ink)
      );
    case 'shift':
      return arrow(cx, cy - u * 0.5, u * 2.2, 'up') + rect(cx - u * 0.4, cy, u * 0.8, u * 1.4, 0, ink);
    default:
      return '';
  }
}

/** A circle; `mark` names it so the "enter" variant can find it. */
function circle(cx, cy, r, style, mark) {
  const attr = mark ? ` data-key="${mark}"` : '';
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" style="${style}"${attr}/>`;
}

/** A key on the edge of the body (PTT and the keys around it), outlined so it shows on black. */
function sideKey(x, y, h, id, colour = '#181818') {
  return rect(x, y, 46, h, 17, `fill:${colour};stroke:#4f4f4f;stroke-width:4`, id);
}

/** The outer shell and the recessed front panel of a handheld, in the mock-ups' proportions. */
function shell({ x = 85, y = 195, w = 605, h = 1340 } = {}) {
  return rect(x, y, w, h, 62, STYLE.body) + rect(x + 37, y + 35, w - 74, h - 70, 52, STYLE.panel);
}

/** Small pictures used on keys instead of text. */
function keyIcon(cx, cy, icon, scale) {
  const s = 26 * scale;
  switch (icon) {
    case 'up':
    case 'down':
    case 'left':
    case 'right':
      return arrow(cx, cy, s * 1.3, icon);
    case 'green':
      // The "menu / accept" key of TYT radios: a green handset block.
      return rect(cx - s * 1.4, cy - s * 0.55, s * 2.8, s * 1.1, 2, `fill:${STYLE.green}`);
    case 'red':
      return rect(cx - s * 1.4, cy - s * 0.55, s * 2.8, s * 1.1, 2, `fill:${STYLE.red}`);
    case 'dot':
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(s * 0.35)}" style="fill:${STYLE.ink}"/>`;
    default:
      return '';
  }
}

/** One key: the raised outline, the cap, the label. */
function key(x, y, w, h, spec, scale = 1) {
  const r = Math.min(h, w) * 0.27;
  const outer = spec.colour ? STYLE.keyOuter.replace('#161616', spec.colour) : STYLE.keyOuter;
  return (
    rect(x, y, w, h, r, outer, spec.id) +
    rect(x + 2.5, y + 2.5, w - 5, h - 5, r - 1, STYLE.keyInner) +
    keyLabel(x + w / 2, y + h / 2, spec, scale)
  );
}

/** An up/down rocker: one tall key split by a groove. */
function rocker(x, y, w, h, id) {
  return (
    rect(x, y, w, h, 17, 'fill:#191919;stroke:#757575;stroke-width:2.6', id) +
    rect(x + 2, y + 2, w - 4, h - 4, 16, 'fill:#191919;stroke:#000000;stroke-width:2.5') +
    rect(x + 2, y + h / 2 - 4, w - 4, 8, 0, 'fill:#000000') +
    arrow(x + w / 2, y + h * 0.26, 46, 'up') +
    arrow(x + w / 2, y + h * 0.74, 46, 'down')
  );
}

/** A round navigation pad with four arrows and, optionally, a centre button. */
function pad(cx, cy, r, { centre = true, id } = {}) {
  const mark = id ? ` data-key="${id}"` : '';
  let out =
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" style="fill:#161616;stroke:#4f4f4f;stroke-width:4"${mark}/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r - 4)}" style="fill:#161616;stroke:#000000;stroke-width:3"/>`;
  const d = r * 0.66;
  out += arrow(cx, cy - d, 22, 'up') + arrow(cx, cy + d, 22, 'down');
  out += arrow(cx - d, cy, 22, 'left') + arrow(cx + d, cy, 22, 'right');
  if (centre) {
    out += `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.36)}" style="fill:#191919;stroke:#4f4f4f;stroke-width:3"/>`;
  }
  return out;
}

/** The screen: a bezel and what the OpenRTX UI shows, as pixels, never stretched. */
function screen({ x, y, w, h, kind }, images) {
  const edge = Math.max(6, w * 0.021);
  const png = images[kind === 'mono' ? 'mono' : 'colour'];
  return (
    rect(x, y, w, h, 14, STYLE.bezel) +
    rect(x + edge, y + edge, w - 2 * edge, h - 2 * edge, 0, 'fill:#000000') +
    `<image x="${n(x + edge)}" y="${n(y + edge)}" width="${n(w - 2 * edge)}" height="${n(h - 2 * edge)}" ` +
    `preserveAspectRatio="xMidYMid meet" style="image-rendering:pixelated" href="${png}"/>`
  );
}

/** Speaker slots, and the brand plate above them when `plate` is given. */
function grille({ x, y, w, rows, pitch = 48, slot = 25 }) {
  let out = '';
  for (let i = 0; i < rows; i++) out += rect(x, y + i * pitch, w, slot, slot / 2, STYLE.slot);
  return out;
}

/** The plate with the brand name. */
function plate({ x, y, w, h = 52, label = 'OPENRTX', size = 42 }) {
  return (
    rect(x, y, w, h, 10, STYLE.slot) + text(x + w / 2, y + h / 2 + size * 0.35, size, escape(label), 'bold')
  );
}

/** A grid of keys from rows of key specs; a `null` cell leaves a gap. */
function keypad({ x, y, w, keyH = 58, gapX = 18, gapY = 16, rows, scale = 1 }) {
  let out = '';
  rows.forEach((row, r) => {
    const keyW = (w - gapX * (row.length - 1)) / row.length;
    row.forEach((cell, c) => {
      if (!cell) return;
      const spec = typeof cell === 'string' ? { main: cell } : cell;
      out += key(x + c * (keyW + gapX), y + r * (keyH + gapY), keyW, keyH, spec, scale);
    });
  });
  return out;
}

/** The tools a spec's `draw` function gets. */
const TOOLS = {
  STYLE,
  rect,
  circle,
  text,
  arrow,
  knob,
  antenna,
  sideKey,
  shell,
  key,
  rocker,
  pad,
  screen,
  grille,
  plate,
  keypad,
};

/** Draws one radio from its spec and returns the SVG text. */
function draw(spec, images) {
  const [width, height] = spec.canvas ?? [763, 1584];
  const parts = spec.draw({ ...TOOLS, screen: (s) => screen(s, images) });
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<!-- ${spec.name}. Drawn for the OpenRTX web flasher in the manner of ` +
    'https://github.com/ranguli/openrtx-device-mockups. GPL-3.0-or-later. -->\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">\n${parts.join('\n')}\n</svg>\n`
  );
}

/**
 * Takes one radio out of the device mock-ups file. Changes to the original: only the
 * named radio's layer is shown, the screen shows the current OpenRTX UI, fonts are named
 * so that the text looks the same on every system, and editor-only attributes (some of
 * which hold local file paths) are removed.
 */
function fromMockup(svg, mockup, images) {
  let out = svg;
  for (const layer of ['cs7000p', 'md3x0', 'c62', 'annotations']) {
    const pattern = new RegExp(`(<g\\b[^>]*inkscape:label="${layer}"[^>]*style=")display:(?:none|inline)`);
    out = out.replace(pattern, `$1display:${layer === mockup.layer ? 'inline' : 'none'}`);
  }
  out = out.replace(/<image\b[^>]*>/g, (tag) =>
    tag
      .replace(/xlink:href="data:[^"]*"/, `xlink:href="${images.colour}"`)
      .replace(/style="/, 'style="image-rendering:pixelated;'),
  );
  out = out.replace(/font-family:[^;"]+/g, `font-family:${FONT}`);
  out = out.replace(/-inkscape-font-specification:[^;"]+;?/g, '');
  for (const [id, fragment] of Object.entries(mockup.keys ?? {})) {
    const tagged = out.replace(new RegExp(`(<rect\\b[^>]*?)(${fragment})`), `$1data-key="${id}" $2`);
    if (tagged === out) throw new Error(`${mockup.layer}: no shape matches ${fragment}`);
    out = tagged;
  }
  // The knobs and side keys are near black, and so is the page: outline them so they do not vanish.
  out = out.replace(/<defs\b[^>]*>/, (defs) => defs + RIM_FILTER);
  out = out.replace(
    /(<g\b)([^>]*inkscape:label="[\w-]*(?:knob|sidekey)-layout")/g,
    '$1 filter="url(#rim)"$2',
  );
  out = out.replace(/<sodipodi:namedview[\s\S]*?<\/sodipodi:namedview>/, '');
  out = out.replace(/\s(?:inkscape:export-[\w-]+|sodipodi:docname)="[^"]*"/g, '');
  return out.replace(
    /<svg/,
    `<!-- ${mockup.name}, from https://github.com/ranguli/openrtx-device-mockups by Joshua Murphy (GPL-3.0). ` +
      'Changed for the OpenRTX web flasher: one radio shown, current OpenRTX UI on the screen, portable fonts, ' +
      'editor metadata removed. -->\n<svg',
  );
}

/** Returns `svg` with the keys named in `held` filled gold. */
function highlight(svg, held) {
  let out = svg;
  for (const id of held) {
    const pattern = new RegExp(`(<(?:rect|circle)\\b[^>]*?)style="([^"]*)"([^>]*data-key="${id}")`);
    const alt = new RegExp(`(<(?:rect|circle)\\b[^>]*data-key="${id}"[^>]*?)style="([^"]*)"`);
    const paint = (_match, before, style, after = '') =>
      `${before}style="${style.replace(/fill:#[0-9a-fA-F]{3,6}/, `fill:${STYLE.gold}`)};stroke:${STYLE.gold};stroke-width:6"${after}`;
    if (pattern.test(out)) out = out.replace(pattern, paint);
    else if (alt.test(out)) out = out.replace(alt, paint);
    else throw new Error(`no key "${id}" to highlight`);
  }
  return out;
}

/** Writes every drawing into `out` and returns the radio ids drawn. */
export function buildArt({ files, out }) {
  const dataUri = (path) => `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  const images = { colour: dataUri(files['screen-colour.png']), mono: dataUri(files['screen-mono.png']) };
  const mockups = readFileSync(files['device-mockups.svg'], 'utf8');
  mkdirSync(out, { recursive: true });
  const done = [];
  const write = (id, svg, held) => {
    writeFileSync(join(out, `${id}.svg`), svg);
    writeFileSync(join(out, `${id}-enter.svg`), held?.length ? highlight(svg, held) : svg);
    done.push(id);
  };
  for (const mockup of MOCKUPS) {
    const svg = fromMockup(mockups, mockup, images);
    for (const id of mockup.radios) write(id, svg, mockup.held[id]);
  }
  for (const spec of SPECS) write(spec.id, draw(spec, images), spec.held);
  return done;
}
