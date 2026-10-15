/**
 * 場のゆがみ補正（Warp Field）— 方向性を確かめるための最小実装。
 *
 * 「描きたい線」と「実際に引ける線」のズレを、作業領域の変位場 D として学習し、ペン入力をゆがめて補正する。
 *
 *   表示位置 = 生の入力位置 + strength · D(x, y, θ, κ)
 *
 *   x, y : ペン位置（client px。手のクセは物理的な動きに付くので、ズーム/パンに依存させない）
 *   θ    : 進行方向
 *   κ    : 今描いている線の曲がり具合（符号付き曲率）
 *
 * 学習（描画とは分離）:
 *   キャリブレーションで「始点・終点・経路」を指定したガイド（直線 / 円弧 / S字）をなぞってもらう。
 *   ガイドが「理想の線」なので、なぞった各点を経路上の対応点（進行に沿って単調に対応付け）と比べ、
 *   その差をサンプルとして蓄える。D はサンプルからのカーネル回帰で求める。
 *
 * 最適化:
 *   ズレ方の傾向は人によって「場所」「方向」「曲がり具合」のどれに強く依存するかが違う。
 *   そこでカーネルの幅（空間 / 方向 / 曲率）と補正の強さを、試行ごとの交差検証
 *   （ある試行を、他の試行だけで学習した場で補正したときの誤差）が最小になるように選ぶ。
 */

export type Pt = { x: number; y: number };
export type PathKind = 'line' | 'arc' | 's';
export const KIND_LABEL: Record<PathKind, string> = { line: '直線', arc: '円弧', s: 'S字' };

type Feat = { a: number | null; k: number; beta: number };
type Sample = { x: number; y: number; a: number; k: number; dx: number; dy: number; trial: number };
type Trial = { id: number; kind: PathKind; path: Pt[]; raw: Pt[] };

/** sigA / sigK が 0 のときはその特徴を使わない（場所だけ・方向だけ…の場になる）。 */
export type Params = { sigS: number; sigA: number; sigK: number; strength: number };
export type TraceResult = { ok: boolean; rawErr: number; shownErr: number };
export type OptResult = { trials: number; before: number; defaultErr: number; after: number; params: Params };
export type Tendency = {
  byKind: { kind: PathKind; n: number; err: number; lateral: number; outward: number | null }[];
  byPhase: { label: string; err: number }[];
  byDir: { deg: number; err: number }[];
};

const STORE_KEY = 'mock.warpField.v2';
const DEFAULT_PARAMS: Params = { sigS: 70, sigA: 0.5, sigK: 0, strength: 1 };
const LAMBDA = 0.6; // データが少ない場所では変位を 0 へ縮める
const MAX_TRIALS = 120; // 古い試行から捨てる（最近の手癖を優先）
const OPT_TRIALS = 40; // 最適化に使う直近の試行数
const SAMPLE_STEP = 8; // 学習サンプルの間引き [px]
const STORE_STEP = 2; // 保存する軌跡の間引き [px]
const DIR_DIST = 12; // 進行方向の推定距離 [px]
const CURV_DIST = 20; // 曲率の推定に使う弦の長さ [px]

export class WarpField {
  enabled = true;
  params: Params = { ...DEFAULT_PARAMS };
  private trials: Trial[] = [];
  private samples: Sample[] = [];
  private nextId = 1;
  private raw: Pt[] | null = null;
  private shown: Pt[] = [];

  constructor() {
    try {
      const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (d) {
        if (Array.isArray(d.trials)) this.trials = d.trials;
        if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
        if (d.params) this.params = { ...DEFAULT_PARAMS, ...d.params };
        this.nextId = this.trials.reduce((m, t) => Math.max(m, t.id + 1), 1);
        this.rebuild();
      }
    } catch {
      /* 保存が読めなくても空の場で動く */
    }
  }

  get strength(): number {
    return this.params.strength;
  }
  set strength(v: number) {
    this.params.strength = v;
  }
  get count(): number {
    return this.samples.length;
  }
  get trialCount(): number {
    return this.trials.length;
  }

  save(): void {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ trials: this.trials, enabled: this.enabled, params: this.params }),
      );
    } catch {
      /* 容量超過などは無視 */
    }
  }

  reset(): void {
    this.trials = [];
    this.samples = [];
    this.params = { ...DEFAULT_PARAMS };
    this.save();
  }

  /* ------------------------------------------------------------ 入力の補正 */

  begin(): void {
    this.raw = [];
    this.shown = [];
  }

  /** 生の入力点（client px）を記録し、表示に使う変位（client px）を返す。 */
  feed(x: number, y: number): [number, number] {
    const raw = this.raw ?? (this.raw = []);
    raw.push({ x, y });
    const f = featureAt(raw, raw.length - 1);
    const d = this.enabled ? this.displacement(x, y, f, this.params) : ([0, 0] as [number, number]);
    this.shown.push({ x: x + d[0], y: y + d[1] });
    return d;
  }

  /** キャンバスへの描画ストロークの終了。描画からは学習しない。 */
  end(): void {
    this.raw = null;
    this.shown = [];
  }

  private displacement(x: number, y: number, f: Feat, p: Params, exclude = -1): [number, number] {
    if (this.samples.length === 0 || p.strength === 0) return [0, 0];
    // 書き始めは方向・曲率が定まらないので、それらを無視した場とブレンドして跳びを防ぐ。
    let [dx, dy] = this.predict(x, y, null, 0, p, exclude);
    if (f.a !== null && f.beta > 0 && (p.sigA > 0 || p.sigK > 0)) {
      const [ex, ey] = this.predict(x, y, f.a, f.k, p, exclude);
      dx = (1 - f.beta) * dx + f.beta * ex;
      dy = (1 - f.beta) * dy + f.beta * ey;
    }
    return [p.strength * dx, p.strength * dy];
  }

  private predict(x: number, y: number, a: number | null, k: number, p: Params, exclude: number): [number, number] {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    const inv = 1 / (2 * p.sigS * p.sigS);
    const cut = 9 * p.sigS * p.sigS;
    const useA = a !== null && p.sigA > 0;
    const useK = a !== null && p.sigK > 0;
    const invA = useA ? 1 / (p.sigA * p.sigA) : 0;
    const invK = useK ? 1 / (2 * p.sigK * p.sigK) : 0;
    for (const s of this.samples) {
      if (s.trial === exclude) continue;
      const ex = s.x - x;
      const ey = s.y - y;
      const d2 = ex * ex + ey * ey;
      if (d2 > cut) continue;
      let e = -d2 * inv;
      if (useA) e += (Math.cos(s.a - (a as number)) - 1) * invA;
      if (useK) e -= (s.k - k) * (s.k - k) * invK;
      const w = Math.exp(e);
      sw += w;
      sx += w * s.dx;
      sy += w * s.dy;
    }
    const kk = 1 / (sw + LAMBDA);
    return [sx * kk, sy * kk];
  }

  /* ------------------------------------------------------------ 学習 */

  /**
   * キャリブレーション試行の終了。指定した経路（始点→終点）を「理想の線」として学習する。
   * 誤差は学習前の場で評価する（rawErr = 手のズレ, shownErr = 補正して表示された線のズレ）。
   */
  endTrace(path: Pt[], kind: PathKind): TraceResult {
    const raw = this.raw ?? [];
    const shown = this.shown;
    this.raw = null;
    this.shown = [];
    if (raw.length < 3 || polyLen(raw) < polyLen(path) * 0.5) return { ok: false, rawErr: 0, shownErr: 0 };
    const rawErr = meanDist(raw, path);
    const shownErr = meanDist(shown, path);
    const t: Trial = { id: this.nextId++, kind, path: thin(path, STORE_STEP), raw: thin(raw, STORE_STEP) };
    this.trials.push(t);
    if (this.trials.length > MAX_TRIALS) this.trials.splice(0, this.trials.length - MAX_TRIALS);
    this.rebuild();
    this.save();
    return { ok: true, rawErr, shownErr };
  }

  /** 試行からサンプルを作り直す（各点を経路上の対応点と比べた差）。 */
  private rebuild(): void {
    this.samples = [];
    for (const t of this.trials) {
      for (const m of matchTrial(t)) {
        if (m.f.a === null) continue;
        this.samples.push({ x: m.p.x, y: m.p.y, a: m.f.a, k: m.f.k, dx: m.q.x - m.p.x, dy: m.q.y - m.p.y, trial: t.id });
      }
    }
  }

  /* ------------------------------------------------------------ 最適化 */

  /**
   * 交差検証（leave-one-trial-out）で、カーネル幅と強さを選ぶ。
   * 評価点ごとの誤差は |strength·D(他の試行だけで学習) − 目標変位|。
   */
  optimize(): OptResult {
    const recent = new Set(this.trials.slice(-OPT_TRIALS).map((t) => t.id));
    const evalPts = this.samples.filter((s) => recent.has(s.trial));
    const before = mean(evalPts.map((s) => Math.hypot(s.dx, s.dy)));
    if (this.trials.length < 3 || evalPts.length === 0) {
      return { trials: this.trials.length, before, defaultErr: before, after: before, params: this.params };
    }
    const predsFor = (p: Params) =>
      evalPts.map((s) => this.displacement(s.x, s.y, { a: s.a, k: s.k, beta: 1 }, { ...p, strength: 1 }, s.trial));
    const cvErr = (strength: number, preds: [number, number][]) =>
      mean(evalPts.map((s, i) => Math.hypot(strength * preds[i][0] - s.dx, strength * preds[i][1] - s.dy)));
    const defaultErr = cvErr(DEFAULT_PARAMS.strength, predsFor(DEFAULT_PARAMS));
    let best: Params = { ...DEFAULT_PARAMS };
    let bestErr = defaultErr;
    for (const sigS of [40, 70, 120]) {
      for (const sigA of [0, 0.35, 0.7]) {
        for (const sigK of [0, 0.003, 0.008]) {
          const preds = predsFor({ sigS, sigA, sigK, strength: 1 });
          for (const strength of [0.5, 0.75, 1, 1.25]) {
            const e = cvErr(strength, preds);
            if (e < bestErr) {
              bestErr = e;
              best = { sigS, sigA, sigK, strength };
            }
          }
        }
      }
    }
    this.params = best;
    this.save();
    return { trials: this.trials.length, before, defaultErr, after: bestErr, params: best };
  }

  /* ------------------------------------------------------------ 傾向の把握 */

  /** ズレ方の傾向（経路の種類別・書き始め/中盤/終わり・方向別）。 */
  tendency(): Tendency {
    const kinds: Record<PathKind, { n: number; err: number[]; lat: number[]; out: number[] }> = {
      line: { n: 0, err: [], lat: [], out: [] },
      arc: { n: 0, err: [], lat: [], out: [] },
      s: { n: 0, err: [], lat: [], out: [] },
    };
    const phase: number[][] = [[], [], []];
    const dirs: number[][] = Array.from({ length: 8 }, () => []);
    for (const t of this.trials) {
      const K = kinds[t.kind];
      K.n++;
      const A = t.path[0];
      const B = t.path[t.path.length - 1];
      const bin = (Math.round(Math.atan2(B.y - A.y, B.x - A.x) / (Math.PI / 4)) + 8) % 8;
      for (const m of matchTrial(t)) {
        const e = Math.hypot(m.p.x - m.q.x, m.p.y - m.q.y);
        K.err.push(e);
        // 進行方向の右側を + とする横ズレ（画面座標は y 下向き）
        const lat = (m.p.x - m.q.x) * -m.ty + (m.p.y - m.q.y) * m.tx;
        K.lat.push(lat);
        // 曲がっている所では「カーブの外側」を + とする（＝浅く描いている）
        if (Math.abs(m.curv) > 0.002) K.out.push(-lat * Math.sign(m.curv));
        phase[Math.min(2, Math.floor(m.u * 3))].push(e);
        dirs[bin].push(e);
      }
    }
    return {
      byKind: (Object.keys(kinds) as PathKind[])
        .filter((k) => kinds[k].n > 0)
        .map((k) => ({
          kind: k,
          n: kinds[k].n,
          err: mean(kinds[k].err),
          lateral: mean(kinds[k].lat),
          outward: kinds[k].out.length ? mean(kinds[k].out) : null,
        })),
      byPhase: ['書き始め', '中盤', '終わり'].map((label, i) => ({ label, err: mean(phase[i]) })),
      byDir: dirs.map((d, i) => ({ deg: i * 45, err: mean(d) })).filter((d) => !Number.isNaN(d.err)),
    };
  }
}

/* ================================================================ 幾何 */

function mean(a: number[]): number {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN;
}
function polyLen(p: Pt[]): number {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
  return L;
}
function thin(p: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (const q of p) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(q.x - l.x, q.y - l.y) >= step) out.push({ x: q.x, y: q.y });
  }
  const last = p[p.length - 1];
  const l = out[out.length - 1];
  if (last && l && (l.x !== last.x || l.y !== last.y)) out.push({ x: last.x, y: last.y });
  return out;
}
function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
/** 経路（細かい折れ線）への平均距離。経路は 2px 間隔なので頂点距離で十分。 */
function meanDist(pts: Pt[], path: Pt[]): number {
  return mean(
    pts.map((p) => {
      let m = Infinity;
      for (const q of path) m = Math.min(m, (p.x - q.x) ** 2 + (p.y - q.y) ** 2);
      return Math.sqrt(m);
    }),
  );
}

/** 直近の点から進行方向と曲率を求める（因果的）。beta は方向の確からしさ 0..1。 */
function featureAt(pts: Pt[], i: number): Feat {
  const p = pts[i];
  const back = (from: Pt, start: number, dist: number) => {
    for (let j = start; j >= 0; j--) if (Math.hypot(from.x - pts[j].x, from.y - pts[j].y) >= dist) return j;
    return -1;
  };
  const j1 = back(p, i - 1, DIR_DIST);
  if (j1 < 0) {
    if (i === 0) return { a: null, k: 0, beta: 0 };
    const d = Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
    if (d < 1) return { a: null, k: 0, beta: 0 };
    return { a: Math.atan2(p.y - pts[0].y, p.x - pts[0].x), k: 0, beta: Math.min(1, d / DIR_DIST) };
  }
  const a = Math.atan2(p.y - pts[j1].y, p.x - pts[j1].x);
  // 曲率: 直近 CURV_DIST の弦と、その手前 CURV_DIST の弦の向きの差 / 長さ
  let k = 0;
  const c1 = back(p, i - 1, CURV_DIST);
  if (c1 >= 0) {
    const q = pts[c1];
    const c2 = back(q, c1 - 1, CURV_DIST);
    if (c2 >= 0) {
      const r = pts[c2];
      const L = (Math.hypot(p.x - q.x, p.y - q.y) + Math.hypot(q.x - r.x, q.y - r.y)) / 2;
      k = wrap(Math.atan2(p.y - q.y, p.x - q.x) - Math.atan2(q.y - r.y, q.x - r.x)) / L;
    }
  }
  return { a, k, beta: 1 };
}

type Match = { p: Pt; q: Pt; f: Feat; tx: number; ty: number; curv: number; u: number };

/**
 * なぞった軌跡の各点を、経路上の対応点に「進行に沿って単調に」対応付ける。
 * 単純な最近点だと、遅れ/行き過ぎや S 字の折り返しで別の場所に吸い付くため。
 */
function matchTrial(t: Trial): Match[] {
  const path = t.path;
  const n = path.length;
  const out: Match[] = [];
  let idx = 0;
  let last: Pt | null = null;
  const WINDOW = 40; // 1 点あたり先読みする経路頂点数（≈80px）
  for (let i = 0; i < t.raw.length; i++) {
    const p = t.raw[i];
    // 対応点は全点で追う（単調性のため）が、サンプルは SAMPLE_STEP ごとに出す
    let best = idx;
    let bd = Infinity;
    const hi = Math.min(n - 1, idx + WINDOW);
    for (let j = idx; j <= hi; j++) {
      const d = (p.x - path[j].x) ** 2 + (p.y - path[j].y) ** 2;
      if (d < bd) {
        bd = d;
        best = j;
      }
    }
    idx = best;
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < SAMPLE_STEP) continue;
    last = p;
    const j0 = Math.max(0, idx - 3);
    const j1 = Math.min(n - 1, idx + 3);
    const tl = Math.hypot(path[j1].x - path[j0].x, path[j1].y - path[j0].y) || 1;
    const tx = (path[j1].x - path[j0].x) / tl;
    const ty = (path[j1].y - path[j0].y) / tl;
    // 経路の曲率（符号付き、画面上で右回り=+）
    const k0 = Math.max(0, idx - 8);
    const k1 = Math.min(n - 1, idx + 8);
    let curv = 0;
    if (k1 - idx >= 2 && idx - k0 >= 2) {
      const ta = Math.atan2(path[idx].y - path[k0].y, path[idx].x - path[k0].x);
      const tb = Math.atan2(path[k1].y - path[idx].y, path[k1].x - path[idx].x);
      curv = wrap(tb - ta) / (Math.hypot(path[k1].x - path[k0].x, path[k1].y - path[k0].y) / 2 || 1);
    }
    out.push({ p, q: path[idx], f: featureAt(t.raw, i), tx, ty, curv, u: idx / Math.max(1, n - 1) });
  }
  return out;
}
