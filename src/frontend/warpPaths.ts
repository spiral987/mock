import type { PathKind, Pt } from './warpField';

/**
 * キャリブレーションと効果テストで共通に使う、ガイド経路（直線 / 円弧 / S字）の生成。
 * 効果テストでは同じお手本を再現できるよう、乱数を差し替えられるようにしてある。
 */

export type Rng = () => number;

/** 種を固定できる乱数（mulberry32）。 */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 配列をその場でシャッフル（Fisher–Yates）。 */
export function shuffle<T>(a: T[], rng: Rng = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function polyLength(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}

/** 折れ線を等間隔（step px）に打ち直す。 */
export function resample(pts: Pt[], step = 2): Pt[] {
  if (pts.length === 0) return [];
  const out: Pt[] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L === 0) continue;
    let d = step - carry;
    while (d <= L) {
      out.push({ x: a.x + ((b.x - a.x) * d) / L, y: a.y + ((b.y - a.y) * d) / L });
      d += step;
    }
    carry = L - (d - step);
  }
  const last = pts[pts.length - 1];
  out.push({ x: last.x, y: last.y });
  return out;
}

/** 折れ線を、長さの割合で n 点に打ち直す（始点と終点を含む）。 */
export function resampleN(pts: Pt[], n: number): Pt[] {
  const total = polyLength(pts);
  if (pts.length < 2 || total === 0) return Array.from({ length: n }, () => ({ ...(pts[0] ?? { x: 0, y: 0 }) }));
  const out: Pt[] = [];
  let seg = 1;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (seg < pts.length - 1) {
      const L = Math.hypot(pts[seg].x - pts[seg - 1].x, pts[seg].y - pts[seg - 1].y);
      if (acc + L >= target) break;
      acc += L;
      seg++;
    }
    const a = pts[seg - 1];
    const b = pts[seg];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const t = Math.max(0, Math.min(1, (target - acc) / L));
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/**
 * 範囲 (L,T,w,h) の中に経路を 1 本作る（はみ出すことはある。呼び出し側で判定する）。
 * 長さは範囲の短辺に対して 45〜85%（短い線で局所的に歪ませないため）。
 */
export function genPath(kind: PathKind, L: number, T: number, w: number, h: number, rng: Rng = Math.random): Pt[] {
  const rnd = (a: number, b: number) => a + rng() * (b - a);
  const minLen = Math.max(200, Math.min(w, h) * 0.45);
  const maxLen = Math.max(minLen + 40, Math.min(w, h) * 0.85);
  const cx = rnd(L + w * 0.2, L + w * 0.8);
  const cy = rnd(T + h * 0.2, T + h * 0.8);
  const pts: Pt[] = [];
  if (kind === 'line') {
    const len = rnd(minLen, maxLen);
    const ang = rnd(0, Math.PI * 2);
    pts.push({ x: cx - (Math.cos(ang) * len) / 2, y: cy - (Math.sin(ang) * len) / 2 });
    pts.push({ x: cx + (Math.cos(ang) * len) / 2, y: cy + (Math.sin(ang) * len) / 2 });
  } else if (kind === 'arc') {
    const r = rnd(minLen / 2.5, maxLen / 2);
    const sweep = rnd(Math.PI / 2, Math.PI * 1.2) * (rng() < 0.5 ? 1 : -1);
    const a0 = rnd(0, Math.PI * 2);
    for (let i = 0; i <= 64; i++) {
      const a = a0 + (sweep * i) / 64;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  } else {
    // S字: 始点→終点の 3 次ベジエ。制御点を経路の左右へ逆向きに振る。
    const len = rnd(minLen, maxLen);
    const ang = rnd(0, Math.PI * 2);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const nx = -uy;
    const ny = ux;
    const hgt = rnd(0.25, 0.45) * len * (rng() < 0.5 ? 1 : -1);
    const A = { x: cx - (ux * len) / 2, y: cy - (uy * len) / 2 };
    const B = { x: cx + (ux * len) / 2, y: cy + (uy * len) / 2 };
    const P1 = { x: A.x + (ux * len) / 3 + nx * hgt, y: A.y + (uy * len) / 3 + ny * hgt };
    const P2 = { x: A.x + (2 * ux * len) / 3 - nx * hgt, y: A.y + (2 * uy * len) / 3 - ny * hgt };
    for (let i = 0; i <= 64; i++) {
      const t = i / 64;
      const m = 1 - t;
      pts.push({
        x: m * m * m * A.x + 3 * m * m * t * P1.x + 3 * m * t * t * P2.x + t * t * t * B.x,
        y: m * m * m * A.y + 3 * m * m * t * P1.y + 3 * m * t * t * P2.y + t * t * t * B.y,
      });
    }
  }
  return resample(pts);
}
