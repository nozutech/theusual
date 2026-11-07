import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { BOLD, MEDIUM } from './glyphs.js';

const WIDTH = 1032;
const LOGO_SIZE = 660;
const MARGIN = 44;
const NUMBER_TOP = 24;
const NUMBER_HEIGHT = 168;
const LABEL_SIZE = 64;
const BARS_TOP = 42;
const BARS_BOTTOM = 34;
const BAR_HEIGHT = 108;
const BAR_HEIGHT_LONG = 72;
const BAR_GAP = 14;
const BAR_RADIUS = 18;
const MAX_COLUMNS = 10;
const RING = { reach: 513, hole: 194 };
// The centre of the largest circle that fits in the corner the ring leaves free.
const MARK_INSET = RING.hole * (Math.SQRT2 - 1);
const MARK_SIZE = 54;
const FADE = 60;
const CURVE_STEPS = 8;
const LOOP_STEPS = 128;
const SAMPLES = 4;
const CAP_HEIGHT = 703;
const SPACE = 210;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (from, to, amount) => from.map((channel, i) => channel + (to[i] - channel) * amount);
const clamp = (value) => Math.min(1, Math.max(0, value));
const radians = (degrees) => (degrees * Math.PI) / 180;

function parsePath(path) {
  const tokens = path.match(/[MLQZ]|-?\d+(?:\.\d+)?/g);
  const contours = [];
  let contour = [];
  let command = 'M';
  let at = 0;
  const next = () => Number(tokens[at++]);

  while (at < tokens.length) {
    if (/[MLQZ]/.test(tokens[at])) command = tokens[at++];
    if (command === 'Z') {
      contours.push(contour);
      contour = [];
    } else if (command === 'Q') {
      const [fromX, fromY] = contour.at(-1);
      const [controlX, controlY, x, y] = [next(), next(), next(), next()];
      for (let step = 1; step <= CURVE_STEPS; step += 1) {
        const t = step / CURVE_STEPS;
        const u = 1 - t;
        contour.push([
          u * u * fromX + 2 * u * t * controlX + t * t * x,
          u * u * fromY + 2 * u * t * controlY + t * t * y,
        ]);
      }
    } else {
      contour.push([next(), next()]);
      command = 'L';
    }
  }
  return contours;
}

const MARK = parsePath(
  / d="([^"]+)"/.exec(readFileSync(new URL('../public/nozutech-mark.svg', import.meta.url), 'utf8'))[1],
);

function place(contours, { scale = 1, x = 0, y = 0, turn = 0 }) {
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return contours.map((contour) => contour.map(([pointX, pointY]) => [
    x + scale * (pointX * cos - pointY * sin),
    y + scale * (pointX * sin + pointY * cos),
  ]));
}

function typeset(text, glyphs) {
  let pen = 0;
  const contours = [...text].flatMap((character) => {
    if (!glyphs[character]) {
      pen += SPACE;
      return [];
    }
    const [advance, path] = glyphs[character];
    const shape = parsePath(path).map((contour) => contour.map(([x, y]) => [pen + x, -y]));
    pen += advance;
    return shape;
  });
  return { contours, width: pen };
}

const centred = (text, glyphs, height) => {
  const { contours, width } = typeset(text, glyphs);
  return place(contours, { x: -width / 2, y: height / 2 });
};

function loop(x, y, radiusX, radiusY, turn = 0, direction = 1) {
  const points = Array.from({ length: LOOP_STEPS }, (_, step) => {
    const angle = (direction * 2 * Math.PI * step) / LOOP_STEPS;
    return [radiusX * Math.cos(angle), radiusY * Math.sin(angle)];
  });
  return place([points], { x, y, turn })[0];
}

const stroke = (x, y, radiusX, radiusY, width, turn) => [
  loop(x, y, radiusX + width / 2, radiusY + width / 2, turn),
  loop(x, y, radiusX - width / 2, radiusY - width / 2, turn, -1),
];

function bar(x, y, width, height, radius) {
  const corners = [
    [x + width - radius, y + radius, -Math.PI / 2],
    [x + width - radius, y + height - radius, 0],
    [x + radius, y + height - radius, Math.PI / 2],
    [x + radius, y + radius, Math.PI],
  ];
  return corners.flatMap(([centreX, centreY, from]) => Array.from({ length: LOOP_STEPS / 8 + 1 }, (_, step) => {
    const angle = from + (Math.PI / 2) * (step / (LOOP_STEPS / 8));
    return [centreX + radius * Math.cos(angle), centreY + radius * Math.sin(angle)];
  }));
}

function middle(contours) {
  const points = contours.flat();
  const reach = (axis) => {
    const values = points.map((point) => point[axis]);
    return [Math.min(...values), Math.max(...values)];
  };
  const [[left, right], [top, bottom]] = [reach(0), reach(1)];
  return { x: (left + right) / 2, y: (top + bottom) / 2, size: Math.max(right - left, bottom - top) };
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const sum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, sum]);
}

function encodePng(pixels, width, height) {
  const rowBytes = width * 4;
  const rows = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    pixels.copy(rows, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function addSpan(row, from, to) {
  const start = Math.max(from, 0);
  const end = Math.min(to, row.length - 1);
  if (end <= start) return;

  const first = Math.floor(start);
  const last = Math.floor(end);
  if (first === last) {
    row[first] += end - start;
    return;
  }
  row[first] += first + 1 - start;
  for (let x = first + 1; x < last; x += 1) row[x] += 1;
  row[last] += end - last;
}

function createCanvas(width, height) {
  const pixels = Buffer.alloc(width * height * 4);

  const blend = (x, y, color, alpha) => {
    const at = (y * width + x) * 4;
    const under = (pixels[at + 3] / 255) * (1 - alpha);
    const total = alpha + under;
    color.forEach((channel, i) => {
      pixels[at + i] = Math.round((channel * alpha + pixels[at + i] * under) / total);
    });
    pixels[at + 3] = Math.round(total * 255);
  };

  // Non-zero winding, so overlapping strokes add up to one shape.
  const fill = (contours, paint, alpha = 1) => {
    const edges = [];
    let top = Infinity;
    let bottom = -Infinity;
    for (const contour of contours) {
      contour.forEach((from, i) => {
        const to = contour[(i + 1) % contour.length];
        if (from[1] !== to[1]) edges.push([from, to]);
        top = Math.min(top, from[1]);
        bottom = Math.max(bottom, from[1]);
      });
    }

    const first = Math.max(0, Math.floor(top));
    const last = Math.min(height - 1, Math.ceil(bottom));
    const rows = Array.from({ length: last - first + 1 }, () => []);
    for (const edge of edges) {
      const [[, fromY], [, toY]] = edge;
      const end = Math.min(last, Math.floor(Math.max(fromY, toY)));
      for (let y = Math.max(first, Math.floor(Math.min(fromY, toY))); y <= end; y += 1) rows[y - first].push(edge);
    }

    for (let y = first; y <= last; y += 1) {
      const row = new Float32Array(width + 1);
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const line = y + (sample + 0.5) / SAMPLES;
        const hits = [];
        for (const [[fromX, fromY], [toX, toY]] of rows[y - first]) {
          if ((fromY <= line) !== (toY <= line)) {
            hits.push([fromX + ((line - fromY) * (toX - fromX)) / (toY - fromY), toY > fromY ? 1 : -1]);
          }
        }
        hits.sort((a, b) => a[0] - b[0]);

        let winding = 0;
        let start = 0;
        for (const [x, direction] of hits) {
          if (!winding) start = x;
          winding += direction;
          if (!winding) addSpan(row, start, x);
        }
      }
      for (let x = 0; x < width; x += 1) {
        const strength = typeof alpha === 'function' ? alpha(x, y) : alpha;
        if (row[x] > 0 && strength > 0) {
          const color = typeof paint === 'function' ? paint(x, y) : paint;
          blend(x, y, color, strength * clamp(row[x] / SAMPLES));
        }
      }
    }
  };

  return { fill, png: () => encodePng(pixels, width, height) };
}

export function initial(name) {
  const letter = [...name.trim()][0]?.toUpperCase().normalize('NFD')[0];
  return BOLD[letter] ? letter : '';
}

// The background stays transparent so the pass colour shows through.
export function renderStamps({ filled, total, brand, leaf, onBrand, label }) {
  const columns = total <= MAX_COLUMNS ? total : Math.ceil(total / 2);
  const rows = total <= MAX_COLUMNS ? 1 : 2;
  const barHeight = rows === 1 ? BAR_HEIGHT : BAR_HEIGHT_LONG;
  const barWidth = (WIDTH - 2 * MARGIN - BAR_GAP * (columns - 1)) / columns;
  const baseline = NUMBER_TOP + NUMBER_HEIGHT;
  const barsTop = baseline + BARS_TOP;
  const height = Math.ceil(barsTop + rows * barHeight + (rows - 1) * BAR_GAP + BARS_BOTTOM);
  const canvas = createCanvas(WIDTH, height);
  const leafColor = rgb(leaf);
  const inkColor = rgb(onBrand);
  const softColor = mix(rgb(brand), inkColor, 0.68);
  const trackColor = mix(rgb(brand), inkColor, 0.11);

  // The figure of public/guilloche.svg in the corner. It fades out where the image ends inside the pass.
  const figure = Array.from({ length: 36 }, (_, i) => stroke(WIDTH, 0, RING.reach, RING.hole, 2.2, radians(i * 5)));
  canvas.fill(figure.flat(), leafColor, (_x, y) => 0.22 * clamp(y / FADE) * clamp((height - y) / FADE));

  const centre = middle(MARK);
  const markScale = MARK_SIZE / centre.size;
  canvas.fill(place(MARK, {
    scale: markScale,
    x: WIDTH - MARK_INSET - centre.x * markScale,
    y: MARK_INSET - centre.y * markScale,
  }), inkColor);

  const scale = NUMBER_HEIGHT / CAP_HEIGHT;
  const number = typeset(String(filled), BOLD);
  canvas.fill(place(number.contours, { scale, x: MARGIN, y: baseline }), leafColor);
  canvas.fill(place(typeset(label, MEDIUM).contours, {
    scale: LABEL_SIZE / 1000,
    x: MARGIN + number.width * scale + 18,
    y: baseline,
  }), softColor);

  for (let index = 0; index < total; index += 1) {
    const x = MARGIN + (index % columns) * (barWidth + BAR_GAP);
    const y = barsTop + Math.floor(index / columns) * (barHeight + BAR_GAP);
    canvas.fill([bar(x, y, barWidth, barHeight, BAR_RADIUS)], index < filled ? leafColor : trackColor);
  }
  return canvas.png();
}

// Google crops the logo to a circle.
export function renderLogo({ accent, onAccent, letter = '' }) {
  const canvas = createCanvas(LOGO_SIZE, LOGO_SIZE);
  const edge = [[0, 0], [LOGO_SIZE, 0], [LOGO_SIZE, LOGO_SIZE], [0, LOGO_SIZE]];
  canvas.fill([edge], rgb(accent));
  if (letter) {
    const shape = centred(letter, BOLD, CAP_HEIGHT);
    canvas.fill(place(shape, { scale: 0.46, x: LOGO_SIZE / 2, y: LOGO_SIZE / 2 }), rgb(onAccent));
  }
  return canvas.png();
}
