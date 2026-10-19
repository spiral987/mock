import type { PathKind, Pt } from './warpField';
import { polyLength, resample, resampleN, seededRng } from './warpPaths';

/**
 * 効果テストの指標計算と集計。
 * 指標はすべてキャンバス座標（px）で、線を長さに沿って打ち直してから計算する
 * （ゆっくり描いた部分ほど点が多くなり、平均がそこに引っ張られるのを防ぐため）。
 */

export type TaskKind = 'trace' | 'memory';
export type Phase = 'practice' | 'main' | 'repeat';
export type Cond = 'on' | 'off';
export const TASK_LABEL: Record<TaskKind, string> = { trace: 'なぞり', memory: '記憶描き' };

export type StrokeMetrics = {
  meanDev: number; // 線→お手本 と お手本→線 の平均距離の平均
  maxDev: number; // 線上でお手本から一番離れた点の距離
  startErr: number;
  endErr: number;
  lengthRatio: number; // 描いた長さ / 経路の長さ
  roughness: number; // 曲がり具合のお手本との差（4px ごとの曲がり角の差の RMS, 度）
};

export type TrialRecord = {
  seq: number;
  phase: Phase;
  task: TaskKind;
  pathId: string;
  kind: PathKind;
  cond: Cond;
  rep: number;
  retries: number;
  inArea: boolean;
  coverage: number;
  fieldMag: number;
  pathLen: number;
  shown: StrokeMetrics;
  rawMeanDev: number;
  rawEndErr: number;
  durationMs: number;
  speed: number; // px/s
  rating: number | null;
  smooth: number;
  strength: number;
  scale: number; // キャンバス px / 画面 px（描いた時点の表示倍率の逆数）
  rotation: number; // 描いた時点の表示の回転（度）
  pointerType: string;
  time: string;
  /** 繰り返し描きの解析用（CSV には出さない） */
  raw: Pt[];
  path: Pt[];
};

/* ---------------------------------------------------------------- 1 本ごとの指標 */

function nearest(p: Pt, pts: Pt[]): number {
  let m = Infinity;
  for (const q of pts) {
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const wrapDeg = (a: number) => {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
};
function turns(p: Pt[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < p.length - 1; i++) {
    const a1 = Math.atan2(p[i].y - p[i - 1].y, p[i].x - p[i - 1].x);
    const a2 = Math.atan2(p[i + 1].y - p[i].y, p[i + 1].x - p[i].x);
    out.push(wrapDeg(((a2 - a1) * 180) / Math.PI));
  }
  return out;
}

export function strokeMetrics(stroke: Pt[], path: Pt[]): StrokeMetrics {
  const s = resample(stroke, 2);
  const p = resample(path, 2);
  const d1 = s.map((q) => nearest(q, p));
  const d2 = p.map((q) => nearest(q, s));
  const pathLen = polyLength(path);
  const n = Math.max(10, Math.round(pathLen / 4));
  const ts = turns(resampleN(stroke, n));
  const tp = turns(resampleN(path, n));
  const rough = Math.sqrt(mean(ts.map((t, i) => (t - tp[i]) ** 2)));
  const A = path[0];
  const B = path[path.length - 1];
  const S = stroke[0];
  const E = stroke[stroke.length - 1];
  return {
    meanDev: (mean(d1) + mean(d2)) / 2,
    maxDev: Math.max(...d1),
    startErr: Math.hypot(S.x - A.x, S.y - A.y),
    endErr: Math.hypot(E.x - B.x, E.y - B.y),
    lengthRatio: polyLength(stroke) / (pathLen || 1),
    roughness: rough,
  };
}

/* ---------------------------------------------------------------- 補正あり/なしの対比較 */

export type PairStat = {
  n: number;
  meanOff: number;
  meanOn: number;
  meanDiff: number; // あり − なし
  ciLo: number;
  ciHi: number;
  medianDiff: number;
  pctChange: number; // 平均の変化率（あり/なし − 1）
  winRate: number; // 補正ありの方が良かったお手本の割合
};

export function pairStat(pairs: { on: number; off: number }[], higherIsBetter = false, seed = 1): PairStat {
  const n = pairs.length;
  const diffs = pairs.map((p) => p.on - p.off);
  const meanDiff = mean(diffs);
  // ブートストラップ（お手本単位で復元抽出）で平均差の 95% 信頼区間
  const rng = seededRng(seed);
  const boots: number[] = [];
  for (let b = 0; b < 2000 && n > 0; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    boots.push(s / n);
  }
  boots.sort((a, b) => a - b);
  const sorted = [...diffs].sort((a, b) => a - b);
  const meanOff = mean(pairs.map((p) => p.off));
  const meanOn = mean(pairs.map((p) => p.on));
  return {
    n,
    meanOff,
    meanOn,
    meanDiff,
    ciLo: boots.length ? boots[Math.floor(boots.length * 0.025)] : NaN,
    ciHi: boots.length ? boots[Math.floor(boots.length * 0.975)] : NaN,
    medianDiff: n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : NaN,
    pctChange: meanOn / meanOff - 1,
    winRate: n ? diffs.filter((d) => (higherIsBetter ? d > 0 : d < 0)).length / n : NaN,
  };
}

export type MetricKey = 'meanDev' | 'endErr' | 'roughness' | 'duration' | 'rating';
export const METRICS: { key: MetricKey; label: string; unit: string; higherIsBetter: boolean }[] = [
  { key: 'meanDev', label: '平均ズレ', unit: 'px', higherIsBetter: false },
  { key: 'endErr', label: '終点のズレ', unit: 'px', higherIsBetter: false },
  { key: 'roughness', label: 'ガタつき', unit: '°', higherIsBetter: false },
  { key: 'duration', label: '時間', unit: 's', higherIsBetter: false },
  { key: 'rating', label: '評価', unit: '', higherIsBetter: true },
];
function valueOf(r: TrialRecord, k: MetricKey): number | null {
  if (k === 'duration') return r.durationMs / 1000;
  if (k === 'rating') return r.rating;
  return r.shown[k];
}

/** 本番の記録を、お手本ごとに「補正あり・なし」の組にする（やり直しは最後の 1 本を採用）。 */
function pairsOf(recs: TrialRecord[]) {
  const by = new Map<string, { on?: TrialRecord; off?: TrialRecord }>();
  for (const r of recs) {
    const e = by.get(r.pathId) ?? {};
    e[r.cond] = r;
    by.set(r.pathId, e);
  }
  return [...by.values()].filter((e) => e.on && e.off) as { on: TrialRecord; off: TrialRecord }[];
}

export type TaskAnalysis = {
  task: TaskKind;
  pairs: number;
  metrics: { key: MetricKey; label: string; unit: string; stat: PairStat }[];
  byKind: { label: string; n: number; off: number; on: number }[];
  byArea: { label: string; n: number; off: number; on: number }[];
  verdict: { dev: boolean; time: boolean; rating: boolean };
};

export function analyzeTask(records: TrialRecord[], task: TaskKind): TaskAnalysis {
  const pairs = pairsOf(records.filter((r) => r.phase === 'main' && r.task === task));
  const metrics = METRICS.map((m, i) => {
    const ps = pairs
      .map((p) => ({ on: valueOf(p.on, m.key), off: valueOf(p.off, m.key) }))
      .filter((p): p is { on: number; off: number } => p.on !== null && p.off !== null);
    return { key: m.key, label: m.label, unit: m.unit, stat: pairStat(ps, m.higherIsBetter, 17 + i) };
  });
  const group = (label: string, sel: (p: { on: TrialRecord }) => boolean) => {
    const g = pairs.filter(sel);
    return { label, n: g.length, off: mean(g.map((p) => p.off.shown.meanDev)), on: mean(g.map((p) => p.on.shown.meanDev)) };
  };
  const dev = metrics.find((m) => m.key === 'meanDev')!.stat;
  const time = metrics.find((m) => m.key === 'duration')!.stat;
  const rating = metrics.find((m) => m.key === 'rating')!.stat;
  return {
    task,
    pairs: pairs.length,
    metrics,
    byKind: [
      group('直線', (p) => p.on.kind === 'line'),
      group('円弧', (p) => p.on.kind === 'arc'),
      group('S字', (p) => p.on.kind === 's'),
    ],
    byArea: [group('学習範囲の内', (p) => p.on.inArea), group('学習範囲の外', (p) => !p.on.inArea)],
    verdict: {
      dev: dev.pctChange <= -0.1 && dev.ciHi < 0,
      time: !(time.pctChange > 0.1),
      rating: !(rating.meanDiff < 0),
    },
  };
}

/* ---------------------------------------------------------------- 直せるズレ / 直せないズレ */

export type RepeatAnalysis = {
  paths: number;
  sys: number; // 毎回同じ向きに出るクセ（RMS, px）
  rand: number; // 毎回ばらばらに出るばらつき（RMS, px）
  correctable: number; // クセの占める割合 = sys² / (sys² + rand²)
  sysAfter: number; // 学習済みの補正をかけたと仮定したときに残るクセ
};

/**
 * 補正なしで同じお手本を複数回なぞった記録から、ズレを「クセ」と「ばらつき」に分ける。
 * 各回の線とお手本を長さの割合で N 点に対応付け、点ごとの平均ズレ（クセ）と、
 * それからの散らばり（ばらつき）を求める。回数が少ないとクセにばらつきが混ざるので、
 * その分（ばらつき² / 回数）を差し引く。
 */
export function analyzeRepeat(records: TrialRecord[], field: (x: number, y: number) => [number, number]): RepeatAnalysis {
  const N = 50;
  const by = new Map<string, TrialRecord[]>();
  for (const r of records) if (r.phase === 'repeat') by.set(r.pathId, [...(by.get(r.pathId) ?? []), r]);
  let sys2 = 0;
  let after2 = 0;
  let rand2 = 0;
  let paths = 0;
  for (const recs of by.values()) {
    const R = recs.length;
    if (R < 2) continue;
    const P = resampleN(recs[0].path, N);
    const E = recs.map((r) => resampleN(r.raw, N).map((q, i) => ({ x: q.x - P[i].x, y: q.y - P[i].y })));
    let b2 = 0;
    let a2 = 0;
    let v2 = 0;
    for (let i = 0; i < N; i++) {
      const bx = mean(E.map((e) => e[i].x));
      const by_ = mean(E.map((e) => e[i].y));
      b2 += bx * bx + by_ * by_;
      // 平均の手の位置に学習済みの補正をかけたときに残るズレ
      const [dx, dy] = field(P[i].x + bx, P[i].y + by_);
      a2 += (bx + dx) ** 2 + (by_ + dy) ** 2;
      for (const e of E) v2 += (e[i].x - bx) ** 2 + (e[i].y - by_) ** 2;
    }
    const r2 = v2 / (N * (R - 1));
    rand2 += r2;
    sys2 += Math.max(0, b2 / N - r2 / R);
    after2 += Math.max(0, a2 / N - r2 / R);
    paths++;
  }
  if (paths === 0) return { paths: 0, sys: NaN, rand: NaN, correctable: NaN, sysAfter: NaN };
  sys2 /= paths;
  rand2 /= paths;
  after2 /= paths;
  return {
    paths,
    sys: Math.sqrt(sys2),
    rand: Math.sqrt(rand2),
    correctable: sys2 / (sys2 + rand2 || 1),
    sysAfter: Math.sqrt(after2),
  };
}

/* ---------------------------------------------------------------- CSV */

export function toCsv(records: TrialRecord[]): string {
  const cols: [string, (r: TrialRecord) => string | number | boolean | null][] = [
    ['seq', (r) => r.seq],
    ['phase', (r) => r.phase],
    ['task', (r) => r.task],
    ['pathId', (r) => r.pathId],
    ['kind', (r) => r.kind],
    ['cond', (r) => r.cond],
    ['rep', (r) => r.rep],
    ['retries', (r) => r.retries],
    ['inArea', (r) => (r.inArea ? 1 : 0)],
    ['coverage', (r) => r.coverage.toFixed(3)],
    ['fieldMag', (r) => r.fieldMag.toFixed(2)],
    ['pathLen', (r) => r.pathLen.toFixed(1)],
    ['meanDev', (r) => r.shown.meanDev.toFixed(2)],
    ['maxDev', (r) => r.shown.maxDev.toFixed(2)],
    ['startErr', (r) => r.shown.startErr.toFixed(2)],
    ['endErr', (r) => r.shown.endErr.toFixed(2)],
    ['lengthRatio', (r) => r.shown.lengthRatio.toFixed(3)],
    ['roughness', (r) => r.shown.roughness.toFixed(2)],
    ['durationMs', (r) => Math.round(r.durationMs)],
    ['speed', (r) => r.speed.toFixed(1)],
    ['rawMeanDev', (r) => r.rawMeanDev.toFixed(2)],
    ['rawEndErr', (r) => r.rawEndErr.toFixed(2)],
    ['rating', (r) => r.rating ?? ''],
    ['smooth', (r) => r.smooth],
    ['strength', (r) => r.strength],
    ['scale', (r) => r.scale.toFixed(4)],
    ['rotation', (r) => r.rotation.toFixed(1)],
    ['pointerType', (r) => r.pointerType],
    ['time', (r) => r.time],
  ];
  const lines = [cols.map((c) => c[0]).join(',')];
  for (const r of records) lines.push(cols.map((c) => String(c[1](r) ?? '')).join(','));
  return lines.join('\n');
}
