// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Which radio drawings come from the device mock-ups file, and the layouts of the ones
 * drawn here. The layouts were taken from product photos: where the knobs, side keys,
 * speaker slots and screen sit, and what is printed on each key. Like the mock-ups, the
 * drawings leave the antenna off and carry "OPENRTX" where the maker's name would be.
 */

/**
 * Radios taken from ranguli's mock-ups. `keys` names shapes in his file (by a fragment
 * of the element that identifies it) so they can be highlighted; `held` lists, per
 * radio, the keys to hold while switching on to enter flashing mode.
 */
export const MOCKUPS = [
  {
    layer: 'cs7000p',
    name: 'Connect Systems CS7000-M17',
    radios: ['cs7000', 'cs7000p'],
    keys: { sk1: 'inkscape:label="sk-1"', ptt: 'inkscape:label="sk-2"', sk2: 'inkscape:label="sk-3"' },
    held: { cs7000: ['sk1'], cs7000p: ['sk1'] },
  },
  {
    layer: 'md3x0',
    name: 'Tytera MD-380',
    radios: ['md3x0'],
    keys: { sk1: 'id="rect102"', ptt: 'id="rect102-3"', sk2: 'id="rect102-0"' },
    held: { md3x0: ['sk1', 'ptt'] },
  },
];

// The column the mock-ups keep the screen and keypad in.
const X = 160;
const W = 455;
const ORANGE = '#ec7f00';
const GREEN = { icon: 'green' };
const RED = { icon: 'red' };
const UP = { icon: 'up' };
const DOWN = { icon: 'down' };

/** The bottom three rows of a four-column TYT-style keypad. */
const TYT_DIGITS = [
  [
    { main: '1', sub: ',.?' },
    { main: '2', sub: 'ABC' },
    { main: '3', sub: 'DEF' },
    { main: '*', glyph: 'lock' },
  ],
  [
    { main: '4', sub: 'GHI' },
    { main: '5', sub: 'JKL' },
    { main: '6', sub: 'MNO' },
    { main: '0', glyph: 'space' },
  ],
  [
    { main: '7', sub: 'PQRS' },
    { main: '8', sub: 'TUV' },
    { main: '9', sub: 'WXYZ' },
    { main: '#', glyph: 'shift' },
  ],
];

/** Side keys of the TYT shape: a small key, the PTT, a small key. */
const tytSide = (t) => [
  t.sideKey(57, 412, 95, 'sk1'),
  t.sideKey(57, 514, 200, 'ptt'),
  t.sideKey(57, 716, 95, 'sk2'),
];

/** Radios drawn here. Each `draw` returns SVG fragments, back to front. */
export const SPECS = [
  {
    id: 'mduv3x0',
    name: 'Tytera MD-UV380 / MD-UV390',
    held: ['sk1', 'ptt'],
    draw: (t) => [
      t.knob({ x: 372, y: 82, w: 108, h: 122 }),
      t.knob({ x: 520, y: 100, w: 96, h: 104 }),
      ...tytSide(t),
      t.shell(),
      t.plate({ x: X - 5, y: 285, w: W + 10 }),
      t.grille({ x: X - 5, y: 372, w: W + 10, rows: 4, pitch: 56 }),
      t.screen({ x: 131, y: 612, w: 512, h: 410, kind: 'colour' }),
      t.keypad({ x: 118, y: 1085, w: 538, rows: [[GREEN, UP, DOWN, RED], ...TYT_DIGITS], scale: 0.9 }),
    ],
  },
  {
    id: 'dm1701',
    name: 'Baofeng DM-1701',
    held: ['sk1', 'ptt'],
    draw: (t) => [
      t.knob({ x: 372, y: 82, w: 108, h: 122 }),
      t.knob({ x: 520, y: 100, w: 96, h: 104 }),
      // SK1 above the PTT, SK2 and SK3 stacked below it.
      t.sideKey(57, 412, 95, 'sk1'),
      t.sideKey(57, 514, 200, 'ptt'),
      t.sideKey(57, 721, 78, 'sk2'),
      t.sideKey(57, 803, 78, 'sk3'),
      t.shell(),
      t.plate({ x: X - 5, y: 280, w: W + 10 }),
      t.screen({ x: 141, y: 355, w: 492, h: 394, kind: 'colour' }),
      t.grille({ x: X - 5, y: 800, w: W + 10, rows: 3, pitch: 70, slot: 38 }),
      // The call keys sit above P1 and P2, with the up and down keys between the pairs.
      t.keypad({
        x: 118,
        y: 1030,
        w: 538,
        rows: [
          [GREEN, null, null, RED],
          ['P1', null, null, 'P2'],
        ],
        scale: 0.9,
      }),
      t.keypad({ x: 257, y: 1067, w: 260, gapX: 18, rows: [[UP, DOWN]], scale: 0.9 }),
      t.keypad({ x: 118, y: 1178, w: 538, rows: TYT_DIGITS, scale: 0.9 }),
    ],
  },
  {
    id: 'md9600',
    name: 'Tytera MD-9600',
    canvas: [1240, 560],
    held: ['orange', 'p1'],
    draw: (t) => {
      const face = 'fill:#161616;stroke:#4f4f4f;stroke-width:4';
      return [
        t.rect(30, 70, 1180, 420, 46, t.STYLE.body),
        t.rect(58, 98, 1124, 364, 34, t.STYLE.panel),
        // Power button and volume knob on the left.
        t.circle(135, 185, 40, 'fill:#161616;stroke:#289300;stroke-width:8'),
        t.circle(135, 185, 16, 'fill:#289300'),
        t.circle(135, 345, 74, face),
        t.rect(130, 280, 10, 60, 0, `fill:${t.STYLE.ink}`),
        t.screen({ x: 248, y: 128, w: 580, h: 222, kind: 'mono' }),
        t.circle(292, 408, 30, `fill:${ORANGE};stroke:#4f4f4f;stroke-width:4`, 'orange'),
        t.keypad({
          x: 345,
          y: 376,
          w: 483,
          keyH: 64,
          gapX: 15,
          rows: [[{ main: 'P1', id: 'p1' }, 'P2', 'P3', 'P4']],
        }),
        // Up, enter, down and band keys in a column, then the channel knob and the microphone socket.
        t.keypad({
          x: 858,
          y: 128,
          w: 112,
          keyH: 68,
          gapY: 12,
          rows: [[UP], [{ main: 'ENT', size: 0.8 }], [DOWN], [{ main: 'BAND', size: 0.62 }]],
        }),
        t.circle(1090, 190, 62, face),
        t.rect(1085, 135, 10, 52, 0, `fill:${t.STYLE.ink}`),
        t.rect(1015, 290, 150, 150, 14, 'fill:#181818;stroke:#343434;stroke-width:3'),
        t.rect(1050, 350, 80, 70, 6, 'fill:#000000;stroke:#4f4f4f;stroke-width:3'),
        t.text(1090, 332, 30, 'MIC', 'bold'),
      ];
    },
  },
  {
    id: 'gd77',
    name: 'Radioddity GD-77',
    held: ['sk1', 'sk2'],
    draw: (t) => [
      t.knob({ x: 150, y: 88, w: 112, h: 116 }),
      t.rect(410, 176, 84, 30, 10, `fill:${ORANGE};stroke:#4f4f4f;stroke-width:4`),
      t.sideKey(57, 330, 300, 'ptt'),
      t.sideKey(57, 650, 92, 'sk1'),
      t.sideKey(57, 762, 92, 'sk2', '#1e5fb4'),
      t.shell(),
      t.plate({ x: X - 5, y: 285, w: W + 10 }),
      t.grille({ x: X + 10, y: 410, w: W - 20, rows: 2, pitch: 118, slot: 44 }),
      t.screen({ x: 151, y: 672, w: 472, h: 230, kind: 'mono' }),
      // Green, up, red over left, down, right; then the digits with *, 0 and # on the right.
      t.keypad({
        x: 146,
        y: 952,
        w: 482,
        rows: [
          [GREEN, UP, RED],
          [{ icon: 'left' }, DOWN, { icon: 'right' }],
        ],
      }),
      t.keypad({ x: 118, y: 1118, w: 538, rows: TYT_DIGITS, scale: 0.9 }),
    ],
  },
  {
    id: 'dm1801',
    name: 'Baofeng DM-1801',
    held: ['sk1', 'sk2'],
    draw: (t) => [
      t.knob({ x: 150, y: 88, w: 112, h: 116 }),
      t.rect(410, 176, 84, 30, 10, `fill:${ORANGE};stroke:#4f4f4f;stroke-width:4`),
      t.sideKey(57, 330, 300, 'ptt'),
      t.sideKey(57, 650, 92, 'sk1'),
      t.sideKey(57, 762, 92, 'sk2'),
      t.shell(),
      t.plate({ x: X - 5, y: 280, w: W + 10 }),
      t.grille({ x: X - 5, y: 372, w: W + 10, rows: 3, pitch: 78, slot: 42 }),
      t.screen({ x: 151, y: 640, w: 472, h: 230, kind: 'mono' }),
      // Menu and back over VFO/MR and A/B, around a four-way pad.
      t.keypad({
        x: 118,
        y: 920,
        w: 538,
        rows: [
          [{ main: 'MENU', size: 0.6 }, null, null, { main: 'BACK', size: 0.6 }],
          [{ main: 'VFO', size: 0.6 }, null, null, { main: 'A/B', size: 0.7 }],
        ],
      }),
      t.pad(387, 985, 72),
      t.keypad({ x: 118, y: 1100, w: 538, rows: TYT_DIGITS, scale: 0.9 }),
    ],
  },
  {
    id: 'rt4d',
    name: 'Radtel RT-4D',
    held: ['ptt'],
    draw: (t) => [
      t.knob({ x: 500, y: 92, w: 108, h: 112 }),
      t.sideKey(57, 330, 270, 'ptt'),
      t.sideKey(57, 620, 92, 'sk1'),
      t.sideKey(57, 732, 92, 'sk2'),
      t.shell(),
      t.rect(322, 222, 130, 24, 12, 'fill:#35c84b'),
      t.screen({ x: 131, y: 290, w: 512, h: 280, kind: 'mono' }),
      t.grille({ x: X - 5, y: 625, w: W + 10, rows: 3, pitch: 66, slot: 36 }),
      t.keypad({ x: 118, y: 838, w: 110, keyH: 56, rows: [[{ icon: 'dot' }]] }),
      t.plate({ x: 250, y: 840, w: 406 }),
      t.keypad({ x: 118, y: 935, w: 538, rows: [[GREEN, UP, DOWN, RED], ...TYT_DIGITS], scale: 0.9 }),
    ],
  },
  {
    id: 'rt950pro',
    name: 'Radtel RT-950 Pro',
    held: ['sk1', 'sk2'],
    // The set of keys is the one OpenRTX's port reads (OK, Back, ABC, V/M, four arrows,
    // twelve digits, two side keys, two knobs). Where they sit on the front is a guess.
    draw: (t) => [
      t.knob({ x: 190, y: 104, w: 96, h: 100 }),
      t.knob({ x: 500, y: 92, w: 108, h: 112 }),
      t.sideKey(57, 330, 270, 'ptt'),
      t.sideKey(57, 620, 92, 'sk1'),
      t.sideKey(57, 732, 92, 'sk2'),
      t.shell(),
      t.plate({ x: 248, y: 226, w: 280 }),
      t.screen({ x: 131, y: 296, w: 512, h: 470, kind: 'colour' }),
      t.keypad({
        x: 146,
        y: 800,
        w: 482,
        keyH: 62,
        gapY: 22,
        rows: [
          [{ main: 'OK', size: 0.7 }, null, { main: 'BACK', size: 0.6 }],
          [{ main: 'ABC', size: 0.6 }, null, { main: 'V/M', size: 0.6 }],
        ],
      }),
      t.pad(387, 873, 82),
      t.keypad({
        x: 146,
        y: 1010,
        w: 482,
        gapX: 44,
        gapY: 22,
        rows: [
          [
            { main: '1', sub: '.,?' },
            { main: '2', sub: 'ABC' },
            { main: '3', sub: 'DEF' },
          ],
          [
            { main: '4', sub: 'GHI' },
            { main: '5', sub: 'JKL' },
            { main: '6', sub: 'MNO' },
          ],
          [
            { main: '7', sub: 'PQRS' },
            { main: '8', sub: 'TUV' },
            { main: '9', sub: 'WXYZ' },
          ],
          [{ main: '*' }, { main: '0' }, { main: '#' }],
        ],
        scale: 0.9,
      }),
    ],
  },
  {
    id: 'c62',
    name: 'Retevis C62 / C2',
    held: ['ptt2'],
    draw: (t) => [
      t.knob({ x: 500, y: 96, w: 112, h: 108 }),
      // The main PTT beside the screen and the one key below it, the secondary PTT.
      t.sideKey(57, 420, 320, 'ptt'),
      t.sideKey(57, 825, 170, 'ptt2'),
      t.shell(),
      t.plate({ x: 248, y: 278, w: 280 }),
      t.screen({ x: 131, y: 350, w: 512, h: 410, kind: 'colour' }),
      // Call keys and P1/P2 either side of the round up/down pad.
      t.keypad({
        x: 146,
        y: 800,
        w: 482,
        keyH: 62,
        gapY: 22,
        rows: [
          [GREEN, null, RED],
          ['P1', null, 'P2'],
        ],
      }),
      t.pad(387, 873, 82, { centre: false }),
      // The only openings on the front: three thin slots between the rows of digits.
      t.rect(251, 1074, 272, 9, 4, t.STYLE.slot),
      t.rect(251, 1154, 272, 9, 4, t.STYLE.slot),
      t.rect(267, 1234, 240, 9, 4, t.STYLE.slot),
      t.keypad({
        x: 146,
        y: 1010,
        w: 482,
        gapX: 44,
        gapY: 22,
        rows: [
          [
            { main: '1', sub: '.,?' },
            { main: '2', sub: 'ABC' },
            { main: '3', sub: 'DEF' },
          ],
          [
            { main: '4', sub: 'GHI' },
            { main: '5', sub: 'JKL' },
            { main: '6', sub: 'MNO' },
          ],
          [
            { main: '7', sub: 'PQRS' },
            { main: '8', sub: 'TUV' },
            { main: '9', sub: 'WXYZ' },
          ],
          [
            { main: '*', glyph: 'lock' },
            { main: '0', glyph: 'space' },
            { main: '#', sub: 'FM' },
          ],
        ],
        scale: 0.9,
      }),
    ],
  },
  {
    id: 'mod17',
    name: 'Module 17',
    canvas: [920, 760],
    draw: (t) => {
      // The rev 1.0 enclosure seen from above. Positions are fractions of the 97 x 80.9 mm
      // top panel, from the project's Module17-HMI board file.
      const px = (f) => 110 + 700 * f;
      const py = (f) => 88 + 584 * f;
      const touch = (fx, fy, label) =>
        t.circle(px(fx), py(fy), 43, 'fill:none;stroke:#ffffff;stroke-width:4') +
        t.text(px(fx), py(fy) + 68, 22, label);
      const led = (i, label) =>
        t.circle(px(0.82), py(0.21 + i * 0.037), 6, i === 0 ? 'fill:#ff0000' : 'fill:#b9b9b9') +
        `<text x="${px(0.82) + 14}" y="${py(0.21 + i * 0.037) + 6}" ` +
        `style="font-family:Arial,Helvetica,sans-serif;font-size:17px;fill:#ffffff">${label}</text>`;
      return [
        // A red extruded case between two black end frames.
        t.rect(110, 88, 700, 584, 6, 'fill:#8f2421;stroke:#4f4f4f;stroke-width:6'),
        t.rect(40, 70, 74, 620, 16, t.STYLE.body),
        t.rect(806, 70, 74, 620, 16, t.STYLE.body),
        t.screen({ x: px(0.3), y: py(0.08), w: 280, h: 175, kind: 'mono' }),
        t.text(px(0.16), py(0.44) + 16, 46, 'M17', 'bold'),
        t.text(px(0.87), py(0.45) - 6, 34, 'OPN', 'bold'),
        t.text(px(0.87), py(0.45) + 32, 34, 'RTX', 'bold'),
        ...['Power', 'PTT', 'Sync', 'Error'].map((label, i) => led(i, label)),
        touch(0.17, 0.25, 'Power'),
        touch(0.29, 0.56, 'Escape'),
        touch(0.5, 0.56, 'Up'),
        touch(0.71, 0.56, 'Enter'),
        touch(0.29, 0.8, 'Left'),
        touch(0.5, 0.8, 'Down'),
        touch(0.71, 0.8, 'Right'),
      ];
    },
  },
  {
    id: 'ttwrplus',
    name: 'Lilygo T-TWR Plus',
    canvas: [520, 1584],
    draw: (t) => {
      const pins = [];
      for (let i = 0; i < 16; i++) {
        pins.push(
          t.circle(148, 930 + i * 34, 7, 'fill:#b8902f'),
          t.circle(372, 930 + i * 34, 7, 'fill:#b8902f'),
        );
      }
      return [
        // Antenna socket, the bare board, and the clear cover over the display.
        t.rect(236, 40, 48, 130, 8, 'fill:#b8902f;stroke:#4f4f4f;stroke-width:3'),
        t.rect(120, 160, 280, 1370, 16, 'fill:#141414;stroke:#4f4f4f;stroke-width:8'),
        t.circle(398, 830, 56, 'fill:#161616;stroke:#4f4f4f;stroke-width:5'),
        t.circle(398, 830, 20, 'fill:#000000;stroke:#343434;stroke-width:3'),
        t.rect(104, 790, 44, 78, 12, 'fill:#8a8a8a;stroke:#4f4f4f;stroke-width:3'),
        t.rect(100, 180, 320, 540, 22, 'fill:#3a3a3a;stroke:#757575;stroke-width:5'),
        t.screen({ x: 125, y: 250, w: 270, h: 150, kind: 'mono' }),
        t.text(260, 620, 44, 'OPENRTX', 'bold'),
        ...pins,
        t.rect(170, 1180, 180, 250, 8, 'fill:#2c2c2c;stroke:#757575;stroke-width:4'),
        t.rect(190, 1200, 140, 150, 4, 'fill:#8a8a8a'),
      ];
    },
  },
];
