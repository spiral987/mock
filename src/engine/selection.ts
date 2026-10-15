import type { BBox, SelectionMask } from '../types';
import type { StampFn } from './strokeRaster';

/**
 * 選択範囲（SelectionMask）のラスタライズと合成。純TS・決定的（乱数もDOMも使わない）。
 *
 * 設計:
 *   - マスクは「キャンバス座標の矩形 + 画素ごとの被覆率 0..255」。矩形の外は被覆 0。
 *   - op には多角形の点列だけを焼き込み、マスクはここで毎回焼き直す。こうしておくと
 *     log だけから選択範囲まで含めて state を再構築でき、不変条件 state === replay(log) が保てる
 *     （マスクの画素を op に持たせると巨大になり、replay も重くなる）。
 *   - 描画側は maskStamp で StampFn を包むだけで選択に従う。選択が無いときは元の関数を
 *     そのまま返すので、選択を使わない限り従来とビット同一の結果になる。
 */

/** 既存の選択範囲との合成方法。 */
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

/** 1画素あたりの縦サブサンプル数。横は解析的に被覆長を求めるので、これだけで十分滑らかになる。 */
const SUBSAMPLES = 4;

/** 選択の内外を分ける被覆率のしきい値（輪郭線・fill の連結判定に使う）。 */
export const SELECTION_EDGE = 128;

/** マスクの矩形（キャンバス座標）。 */
export function selectionBounds(sel: SelectionMask): BBox {
  return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
}

/** キャンバス座標 (x,y) の被覆率 0..1。sel が null なら常に 1（＝選択なし＝全面）。 */
export function selectionCoverage(sel: SelectionMask | null | undefined, x: number, y: number): number {
  if (!sel) return 1;
  const lx = x - sel.x;
  const ly = y - sel.y;
  if (lx < 0 || ly < 0 || lx >= sel.w || ly >= sel.h) return 0;
  return sel.data[ly * sel.w + lx] / 255;
}

/** 選択されている画素が 1 つも無いか。 */
export function isSelectionEmpty(sel: SelectionMask | null | undefined): boolean {
  if (!sel || sel.w <= 0 || sel.h <= 0) return true;
  for (let i = 0; i < sel.data.length; i++) if (sel.data[i] > 0) return false;
  return true;
}

/** 選択範囲の面積（被覆率 >= しきい値の画素数）。UI 表示用。 */
export function selectionArea(sel: SelectionMask | null | undefined): number {
  if (!sel) return 0;
  let n = 0;
  for (let i = 0; i < sel.data.length; i++) if (sel.data[i] >= SELECTION_EDGE) n++;
  return n;
}

/** 2つの選択マスクが同値かを比較する。 */
export function selectionsEqual(
  a: SelectionMask | null | undefined,
  b: SelectionMask | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (a.x !== b.x || a.y !== b.y || a.w !== b.w || a.h !== b.h) return false;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/**
 * StampFn を選択範囲でマスクする。stamp が受け取る座標はバッファローカルなので、
 * offset を足してキャンバス座標に直してから被覆率を引く。
 * sel が無いときは元の関数をそのまま返す（＝選択未使用時は従来とビット同一）。
 */
export function maskStamp(
  stamp: StampFn,
  sel: SelectionMask | null | undefined,
  offsetX: number,
  offsetY: number,
): StampFn {
  if (!sel) return stamp;
  const { x: sx, y: sy, w, h, data } = sel;
  const ox = Math.round(offsetX);
  const oy = Math.round(offsetY);
  return (buf, x, y, alpha) => {
    const lx = x + ox - sx;
    const ly = y + oy - sy;
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return;
    const cov = data[ly * w + lx];
    if (cov === 0) return;
    stamp(buf, x, y, alpha * (cov / 255));
  };
}

// ---- 多角形のラスタライズ ---------------------------------------------------

/** span [a,b)（マスクローカルの実数x）の被覆長を行アキュムレータへ足す。 */
function addSpan(acc: Float32Array, a: number, b: number): void {
  const w = acc.length;
  let xa = a < 0 ? 0 : a;
  let xb = b > w ? w : b;
  if (xb <= xa) return;
  const i0 = Math.floor(xa);
  const i1 = Math.ceil(xb);
  for (let i = i0; i < i1 && i < w; i++) {
    const lo = xa > i ? xa : i;
    const hi = xb < i + 1 ? xb : i + 1;
    if (hi > lo) acc[i] += hi - lo;
  }
}

/**
 * 多角形（キャンバス座標の平坦配列 [x0,y0,x1,y1,...]、閉じているものとして扱う）を
 * 被覆マスクへ焼く。nonzero winding 規則（投げ縄が自己交差しても中が抜けない）。
 *
 * 縦は SUBSAMPLES 本のスキャンライン、横は交点間の被覆長を解析的に足すので、
 * 縁は滑らかなアンチエイリアスになる。全演算が入力だけで決まるので決定的。
 *
 * 戻り値は clip 矩形 [0,clipW]×[0,clipH] に収めた最小矩形のマスク。空なら null。
 */
export function rasterizePolygon(
  path: readonly number[],
  clipW: number,
  clipH: number,
): SelectionMask | null {
  const n = (path.length / 2) | 0;
  if (n < 3) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const px = path[i * 2];
    const py = path[i * 2 + 1];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(clipW, Math.ceil(maxX));
  const y1 = Math.min(clipH, Math.ceil(maxY));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const data = new Uint8Array(w * h);
  const acc = new Float32Array(w);
  // 交点バッファ（x と向き）。1スキャンラインで最大 n 本の辺と交わる。
  const xs = new Float64Array(n);
  const dirs = new Int8Array(n);
  const order = new Int32Array(n);
  const inv = 1 / SUBSAMPLES;
  let any = false;

  for (let py = y0; py < y1; py++) {
    acc.fill(0);
    for (let s = 0; s < SUBSAMPLES; s++) {
      const sy = py + (s + 0.5) * inv;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        const j = i === n - 1 ? 0 : i + 1;
        const ay = path[i * 2 + 1];
        const by = path[j * 2 + 1];
        // 半開区間 [ay, by) で判定すると頂点をまたぐ辺を二重に数えない。
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          const ax = path[i * 2];
          const bx = path[j * 2];
          xs[cnt] = ax + ((bx - ax) * (sy - ay)) / (by - ay);
          dirs[cnt] = by > ay ? 1 : -1;
          cnt++;
        }
      }
      if (cnt < 2) continue;
      // x 昇順の並び（挿入ソート: 交点数は普通ごく少ないので十分速い）。
      for (let i = 0; i < cnt; i++) order[i] = i;
      for (let i = 1; i < cnt; i++) {
        const k = order[i];
        const kx = xs[k];
        let j = i - 1;
        while (j >= 0 && xs[order[j]] > kx) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = k;
      }
      // nonzero winding: 巻き数が 0 でない区間を塗る。
      let wind = 0;
      let spanStart = 0;
      for (let i = 0; i < cnt; i++) {
        const k = order[i];
        const prev = wind;
        wind += dirs[k];
        if (prev === 0 && wind !== 0) spanStart = xs[k];
        else if (prev !== 0 && wind === 0) addSpan(acc, spanStart - x0, xs[k] - x0);
      }
    }
    const row = (py - y0) * w;
    for (let i = 0; i < w; i++) {
      const v = acc[i] * inv;
      if (v <= 0) continue;
      const c = v >= 1 ? 255 : Math.round(v * 255);
      if (c > 0) {
        data[row + i] = c;
        any = true;
      }
    }
  }
  if (!any) return null;
  return trimMask({ x: x0, y: y0, w, h, data });
}

/** 被覆 0 の余白を削って矩形を詰める（空なら null）。 */
export function trimMask(sel: SelectionMask): SelectionMask | null {
  const { x, y, w, h, data } = sel;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let py = 0; py < h; py++) {
    const row = py * w;
    for (let px = 0; px < w; px++) {
      if (data[row + px] === 0) continue;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  }
  if (maxX < minX) return null;
  const nw = maxX - minX + 1;
  const nh = maxY - minY + 1;
  if (nw === w && nh === h) return sel;
  const out = new Uint8Array(nw * nh);
  for (let py = 0; py < nh; py++) {
    const src = (py + minY) * w + minX;
    out.set(data.subarray(src, src + nw), py * nw);
  }
  return { x: x + minX, y: y + minY, w: nw, h: nh, data: out };
}

/**
 * 既存の選択 prev に next を mode で合成する。結果が空なら null（＝選択解除）。
 * 被覆率は 0..255 のまま扱い、加算は max・減算は (1-b)・積は a*b/255 で計算する（すべて決定的）。
 */
export function combineSelection(
  prev: SelectionMask | null | undefined,
  next: SelectionMask | null,
  mode: SelectionMode,
): SelectionMask | null {
  if (mode === 'replace') return next;
  if (!prev) return mode === 'add' ? next : null; // 選択が無い状態からの減算/交差は空のまま
  if (!next) return mode === 'subtract' ? prev : mode === 'intersect' ? null : prev;

  // 出力矩形: add=和, subtract=prev のまま, intersect=積
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  if (mode === 'add') {
    x = Math.min(prev.x, next.x);
    y = Math.min(prev.y, next.y);
    w = Math.max(prev.x + prev.w, next.x + next.w) - x;
    h = Math.max(prev.y + prev.h, next.y + next.h) - y;
  } else if (mode === 'intersect') {
    x = Math.max(prev.x, next.x);
    y = Math.max(prev.y, next.y);
    w = Math.min(prev.x + prev.w, next.x + next.w) - x;
    h = Math.min(prev.y + prev.h, next.y + next.h) - y;
    if (w <= 0 || h <= 0) return null;
  } else {
    x = prev.x;
    y = prev.y;
    w = prev.w;
    h = prev.h;
  }

  const data = new Uint8Array(w * h);
  for (let py = 0; py < h; py++) {
    const cy = y + py;
    for (let px = 0; px < w; px++) {
      const cx = x + px;
      const a = Math.round(selectionCoverage(prev, cx, cy) * 255);
      const b = Math.round(selectionCoverage(next, cx, cy) * 255);
      let v: number;
      if (mode === 'add') v = a > b ? a : b;
      else if (mode === 'subtract') v = Math.round((a * (255 - b)) / 255);
      else v = Math.round((a * b) / 255);
      data[py * w + px] = v;
    }
  }
  return trimMask({ x, y, w, h, data });
}

// ---- 輪郭（マーチングアンツ表示用） -----------------------------------------

/**
 * マスクの輪郭を閉ループの点列（キャンバス座標の平坦配列）として取り出す。
 * 「選択画素と非選択画素の境界にある単位辺」を集め、端点でつないでループにする。
 * 破線を流すには 1 本の連続したパスが要る（バラバラの線分だと破線の位相が揃わない）ため。
 */
export function traceSelectionOutline(sel: SelectionMask): number[][] {
  const { x: ox, y: oy, w, h, data } = sel;
  const inside = (px: number, py: number) =>
    px >= 0 && py >= 0 && px < w && py < h && data[py * w + px] >= SELECTION_EDGE;

  // 格子点 (w+1)×(h+1) を頂点とする無向グラフ。各頂点の接続辺を最大4本まで持つ。
  const vw = w + 1;
  const key = (vx: number, vy: number) => vy * vw + vx;
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const la = adj.get(a);
    if (la) la.push(b);
    else adj.set(a, [b]);
    const lb = adj.get(b);
    if (lb) lb.push(a);
    else adj.set(b, [a]);
  };
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      if (!inside(px, py)) continue;
      if (!inside(px - 1, py)) link(key(px, py), key(px, py + 1));
      if (!inside(px + 1, py)) link(key(px + 1, py), key(px + 1, py + 1));
      if (!inside(px, py - 1)) link(key(px, py), key(px + 1, py));
      if (!inside(px, py + 1)) link(key(px, py + 1), key(px + 1, py + 1));
    }
  }

  // 使用済み辺の集合。辺は必ず隣接格子点どうしなので「小さい方の頂点 + 向き(横/縦)」で一意に決まる
  // （頂点2つを掛け合わせたキーだと 16384px 級のマスクで 2^53 を超えて衝突しうる）。
  const used = new Set<number>();
  const edgeKey = (a: number, b: number) => {
    const lo = a < b ? a : b;
    return lo * 2 + (a - b === 1 || b - a === 1 ? 0 : 1);
  };
  const loops: number[][] = [];
  for (const [start, firstNeighbors] of adj) {
    for (const first of firstNeighbors) {
      if (used.has(edgeKey(start, first))) continue;
      const pts: number[] = [];
      let prev = start;
      let cur = first;
      used.add(edgeKey(prev, cur));
      pts.push((prev % vw) + ox, ((prev / vw) | 0) + oy);
      // 端点をたどって閉じるまで進む（境界辺は必ず閉ループを作る）。
      for (;;) {
        pts.push((cur % vw) + ox, ((cur / vw) | 0) + oy);
        if (cur === start) break;
        const ns = adj.get(cur);
        if (!ns) break;
        let next = -1;
        for (const cand of ns) {
          if (used.has(edgeKey(cur, cand))) continue;
          next = cand;
          break;
        }
        if (next < 0) break;
        used.add(edgeKey(cur, next));
        prev = cur;
        cur = next;
      }
      if (pts.length >= 6) loops.push(simplifyLoop(pts));
    }
  }
  return loops;
}

/** 同一直線上に続く点を間引く（描画コストを落とすだけで形は変わらない）。 */
function simplifyLoop(pts: number[]): number[] {
  const out: number[] = [pts[0], pts[1]];
  for (let i = 1; i < pts.length / 2 - 1; i++) {
    const px = pts[(i - 1) * 2];
    const py = pts[(i - 1) * 2 + 1];
    const cx = pts[i * 2];
    const cy = pts[i * 2 + 1];
    const nx = pts[(i + 1) * 2];
    const ny = pts[(i + 1) * 2 + 1];
    if ((cx - px) * (ny - cy) === (cy - py) * (nx - cx)) continue; // 曲がっていない
    out.push(cx, cy);
  }
  out.push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}
