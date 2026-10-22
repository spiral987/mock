/**
 * 場のゆがみ補正（Warp Field）— 方向性を確かめるための最小実装。
 *
 * キャンバス全体を変形範囲とする「なめらかなメッシュ変形」として、ペン入力をゆがめる。
 *
 *   表示位置 = 生の入力位置 + strength · D(x, y)
 *
 *   D はキャンバス上に張った粗い制御格子（1 辺 CELLS マス）の各節点の変位を、3 次 B スプラインで
 *   なめらかに補間したもの。位置だけで決まる滑らかな場なので、描画中に細かく揺れない。
 *   座標は場ごとに決まる（方式A＝キャンバス座標 px、方式B＝画面の入力座標 px）。
 *
 * 学習（描画とは分離）:
 *   キャリブレーションで「始点・終点・経路」を指定したガイド（直線 / 円弧 / S字）をなぞってもらう。
 *   なぞった各点を経路上の対応点（進行に沿って単調に対応付け）と比べた差をサンプルとし、
 *   「サンプルへの当てはまり + なめらかさ（隣の節点との差）+ 0 への引き戻し」を最小にする
 *   節点の変位を最小二乗で解く。データの無い場所は、なめらかさの項で周囲から補われ、遠くでは 0 に戻る。
 *
 * 最適化:
 *   なめらかさの強さ λ と補正の強さを、試行ごとの交差検証
 *   （ある試行を、他の試行だけで解いた場で補正したときの誤差）が最小になるように選ぶ。
 */

export type Pt = { x: number; y: number };
export type PathKind = 'line' | 'arc' | 's';
export const KIND_LABEL: Record<PathKind, string> = { line: '直線', arc: '円弧', s: 'S字' };

type Sample = { x: number; y: number; dx: number; dy: number };
/**
 * 1 本分の学習データ。path・raw の座標系は場ごとに決まる（方式A＝キャンバス座標、方式B＝画面の入力座標）。
 * rot: 以前の版で記録していた表示の回転角 [度]。現在は学習に使わない（読み込んだデータの互換のために残す）。
 */
type Trial = { id: number; kind: PathKind; path: Pt[]; raw: Pt[]; rot?: number };

/** smooth: なめらかさ λ（大きいほど場がゆるやかに歪む）, strength: 補正の強さ */
export type Params = { smooth: number; strength: number };
export type TraceResult = { ok: boolean; rawErr: number; shownErr: number };
/** 場の大きさ（強さ 1 のとき）と、格子が折り返さない強さの上限。補正量の確認用。 */
export type FieldStats = { maxDisp: number; meanDisp: number; foldStrength: number };
/** 直前の 1 本で実際に足した変位（キャンバス px、強さ込み・補正 OFF なら 0）。 */
export type StrokeDisp = { mean: number; max: number; n: number };
export type OptResult = { trials: number; before: number; defaultErr: number; after: number; params: Params };
export type Tendency = {
  byKind: { kind: PathKind; n: number; err: number; lateral: number; outward: number | null }[];
  byPhase: { label: string; err: number }[];
  byDir: { deg: number; err: number }[];
};

/** 方式A（キャンバス固定）の保存先。既存の学習データはこの場のもの。 */
export const STORE_KEY_CANVAS = 'mock.warpField.v3';
/** 方式B（入力座標系固定）の保存先。画面の入力座標で学習したデータだけを入れる。 */
export const STORE_KEY_SCREEN = 'mock.warpField.screen.v1';
const DEFAULT_PARAMS: Params = { smooth: 30, strength: 1 };
const SMOOTH_GRID = [10, 30, 100, 300, 1000]; // 小さすぎる λ は局所的な歪み（描画時のブレ）の元になるので使わない
const STRENGTH_GRID = [0.5, 0.75, 1];
const CELLS = 8; // キャンバスの長辺を何マスの制御格子で覆うか
const RIDGE_RATIO = 1 / 16; // 0 への引き戻し = λ × これ（データの無い所の減衰距離 ≈ 4 マス）
const MAX_TRIALS = 120; // 古い試行から捨てる（最近の手癖を優先）
const OPT_TRIALS = 40; // 最適化に使う直近の試行数
const SAMPLE_STEP = 8; // 学習サンプルの間引き [px]
const STORE_STEP = 2; // 保存する軌跡の間引き [px]

/** 3 次 B スプラインの基底（台は ±2）。 */
function bspline(t: number): number {
  const a = Math.abs(t);
  if (a < 1) return (4 - 6 * a * a + 3 * a * a * a) / 6;
  if (a < 2) return ((2 - a) * (2 - a) * (2 - a)) / 6;
  return 0;
}

export class WarpField {
  enabled = true;
  params: Params = { ...DEFAULT_PARAMS };
  private trials: Trial[] = [];
  private nextId = 1;
  private raw: Pt[] | null = null;
  private shown: Pt[] = [];
  // 1 本のあいだに実際に足した変位の集計（補正量の確認用）
  private dispSum = 0;
  private dispMax = 0;
  private dispN = 0;
  lastStroke: StrokeDisp = { mean: 0, max: 0, n: 0 };
  // 制御格子
  private W = 0;
  private H = 0;
  private h = 1; // 節点間隔 [px]
  private nx = 0;
  private ny = 0;
  private cx: Float64Array = new Float64Array(0);
  private cy: Float64Array = new Float64Array(0);
  private nSamples = 0;
  /** 学習データのあるマス（節点間隔の半分の格子）。効果テストで「学習範囲の内/外」の判定に使う。 */
  private covered = new Set<string>();

  private storeKey: string;

  /**
   * storeKey: 学習データの保存先。場の座標系（キャンバス座標 / 画面の入力座標）は、
   * setCanvas() で張る範囲と、feed()/endTrace() に渡す座標で決まる（計算の中身は共通）。
   */
  constructor(storeKey: string = STORE_KEY_CANVAS) {
    this.storeKey = storeKey;
    try {
      const d = JSON.parse(localStorage.getItem(this.storeKey) || 'null');
      if (d) {
        if (Array.isArray(d.trials)) this.trials = d.trials;
        if (typeof d.enabled === 'boolean') this.enabled = d.enabled;
        if (d.params) this.params = { ...DEFAULT_PARAMS, ...d.params };
        this.nextId = this.trials.reduce((m, t) => Math.max(m, t.id + 1), 1);
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
    return this.nSamples;
  }
  get trialCount(): number {
    return this.trials.length;
  }

  save(): void {
    try {
      localStorage.setItem(
        this.storeKey,
        JSON.stringify({ trials: this.trials, enabled: this.enabled, params: this.params }),
      );
    } catch {
      /* 容量超過などは無視 */
    }
  }

  reset(): void {
    this.trials = [];
    this.params = { ...DEFAULT_PARAMS };
    this.fit();
    this.save();
  }

  /** 変形範囲（キャンバスサイズ）を設定。サイズが変わったら格子を張り直して解き直す。 */
  setCanvas(W: number, H: number): void {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.h = Math.max(W, H) / CELLS;
    this.nx = Math.ceil(W / this.h) + 3;
    this.ny = Math.ceil(H / this.h) + 3;
    this.fit();
  }

  /* ------------------------------------------------------------ 場の評価 */

  /** 点 (x,y) に効く節点（最大 4×4）とその重み。 */
  private basis(x: number, y: number): { idx: number[]; w: number[] } {
    const u = x / this.h + 1; // 節点 i の位置は (i-1)·h
    const v = y / this.h + 1;
    const iu = Math.floor(u);
    const iv = Math.floor(v);
    const idx: number[] = [];
    const w: number[] = [];
    for (let j = iv - 1; j <= iv + 2; j++) {
      if (j < 0 || j >= this.ny) continue;
      const bv = bspline(v - j);
      if (bv === 0) continue;
      for (let i = iu - 1; i <= iu + 2; i++) {
        if (i < 0 || i >= this.nx) continue;
        const bu = bspline(u - i);
        if (bu === 0) continue;
        idx.push(j * this.nx + i);
        w.push(bu * bv);
      }
    }
    return { idx, w };
  }

  private evalWith(cx: Float64Array, cy: Float64Array, x: number, y: number): [number, number] {
    const { idx, w } = this.basis(x, y);
    let dx = 0;
    let dy = 0;
    for (let k = 0; k < idx.length; k++) {
      dx += w[k] * cx[idx[k]];
      dy += w[k] * cy[idx[k]];
    }
    return [dx, dy];
  }

  /** 学習済みの場の変位（強さ込み、補正 ON/OFF には依らない）。格子表示にも使う。 */
  displacementAt(x: number, y: number): [number, number] {
    if (this.cx.length === 0) return [0, 0];
    const [dx, dy] = this.evalWith(this.cx, this.cy, x, y);
    return [this.params.strength * dx, this.params.strength * dy];
  }

  /** (x,y) の近く（そのマスか隣のマス）に学習データがあるか。 */
  isCovered(x: number, y: number): boolean {
    const c = this.h / 2;
    const i = Math.floor(x / c);
    const j = Math.floor(y / c);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) if (this.covered.has(`${i + di},${j + dj}`)) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ 入力の補正 */

  begin(): void {
    this.raw = [];
    this.shown = [];
    this.dispSum = 0;
    this.dispMax = 0;
    this.dispN = 0;
  }

  /** 生の入力点（キャンバス px）を記録し、表示に使う変位を返す。 */
  feed(x: number, y: number): [number, number] {
    (this.raw ?? (this.raw = [])).push({ x, y });
    const d = this.enabled ? this.displacementAt(x, y) : ([0, 0] as [number, number]);
    this.shown.push({ x: x + d[0], y: y + d[1] });
    const m = Math.hypot(d[0], d[1]);
    this.dispSum += m;
    this.dispMax = Math.max(this.dispMax, m);
    this.dispN++;
    return d;
  }

  /** キャンバスへの描画ストロークの終了。描画からは学習しない。 */
  end(): void {
    this.lastStroke = { mean: this.dispN ? this.dispSum / this.dispN : 0, max: this.dispMax, n: this.dispN };
    this.raw = null;
    this.shown = [];
  }

  /**
   * 学習済みの場の大きさ（強さ 1 のとき）をキャンバス全体で調べる。
   * あわせて、写像 p → p + s·D(p) が折り返さない（格子が裏返らない）強さ s の上限を求める。
   * 各点のヤコビアン I + s·∇D の行列式 1 + s·tr(∇D) + s²·det(∇D) が 0 になる最小の正の s。
   */
  fieldStats(): FieldStats {
    if (this.W === 0 || this.cx.length === 0) return { maxDisp: 0, meanDisp: 0, foldStrength: Infinity };
    const step = Math.max(this.W, this.H) / 48;
    const nx = Math.floor(this.W / step) + 1;
    const ny = Math.floor(this.H / step) + 1;
    const D: [number, number][] = [];
    let sum = 0;
    let max = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const d = this.evalWith(this.cx, this.cy, Math.min(i * step, this.W), Math.min(j * step, this.H));
        D.push(d);
        const m = Math.hypot(d[0], d[1]);
        sum += m;
        max = Math.max(max, m);
      }
    }
    let fold = Infinity;
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const d0 = D[j * nx + i];
        const dxp = D[j * nx + i + 1];
        const dyp = D[(j + 1) * nx + i];
        const a = (dxp[0] - d0[0]) / step; // ∂Dx/∂x
        const b = (dyp[0] - d0[0]) / step; // ∂Dx/∂y
        const c = (dxp[1] - d0[1]) / step; // ∂Dy/∂x
        const e = (dyp[1] - d0[1]) / step; // ∂Dy/∂y
        const tr = a + e;
        const det = a * e - b * c;
        let s = Infinity;
        if (Math.abs(det) < 1e-12) {
          if (tr < 0) s = -1 / tr;
        } else {
          const disc = tr * tr - 4 * det;
          if (disc >= 0) {
            const r = Math.sqrt(disc);
            for (const root of [(-tr - r) / (2 * det), (-tr + r) / (2 * det)]) if (root > 0) s = Math.min(s, root);
          }
        }
        fold = Math.min(fold, s);
      }
    }
    return { maxDisp: max, meanDisp: sum / D.length, foldStrength: fold };
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
    this.trials.push({
      id: this.nextId++,
      kind,
      path: thin(path, STORE_STEP),
      raw: thin(raw, STORE_STEP),
    });
    if (this.trials.length > MAX_TRIALS) this.trials.splice(0, this.trials.length - MAX_TRIALS);
    this.fit();
    this.save();
    return { ok: true, rawErr, shownErr };
  }

  /** 試行からサンプルを作る。位置もズレの向きも、試行を記録した座標系のまま使う。 */
  private samplesOf(t: Trial): Sample[] {
    return matchTrial(t).map((m) => ({ x: m.p.x, y: m.p.y, dx: m.q.x - m.p.x, dy: m.q.y - m.p.y }));
  }

  /** 正規方程式の寄与（データ項）を試行ごとに作る。 */
  private normalOf(samples: Sample[]): { A: Float64Array; bx: Float64Array; by: Float64Array } {
    const n = this.nx * this.ny;
    const A = new Float64Array(n * n);
    const bx = new Float64Array(n);
    const by = new Float64Array(n);
    for (const s of samples) {
      const { idx, w } = this.basis(s.x, s.y);
      for (let a = 0; a < idx.length; a++) {
        bx[idx[a]] += w[a] * s.dx;
        by[idx[a]] += w[a] * s.dy;
        for (let b = 0; b < idx.length; b++) A[idx[a] * n + idx[b]] += w[a] * w[b];
      }
    }
    return { A, bx, by };
  }

  /** なめらかさの行列（隣り合う節点の差の二乗和）+ 0 への引き戻し。 */
  private regularizer(): Float64Array {
    const n = this.nx * this.ny;
    const R = new Float64Array(n * n);
    const pair = (p: number, q: number) => {
      R[p * n + p] += 1;
      R[q * n + q] += 1;
      R[p * n + q] -= 1;
      R[q * n + p] -= 1;
    };
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const p = j * this.nx + i;
        if (i + 1 < this.nx) pair(p, p + 1);
        if (j + 1 < this.ny) pair(p, p + this.nx);
        R[p * n + p] += RIDGE_RATIO;
      }
    }
    return R;
  }

  /** (A + λR) c = b を解く。 */
  private solve(A: Float64Array, R: Float64Array, lambda: number, bx: Float64Array, by: Float64Array) {
    const n = bx.length;
    const M = new Float64Array(n * n);
    for (let k = 0; k < n * n; k++) M[k] = A[k] + lambda * R[k];
    const L = cholesky(M, n);
    return { cx: cholSolve(L, n, bx), cy: cholSolve(L, n, by) };
  }

  private fit(): void {
    const n = this.nx * this.ny;
    if (n === 0) return;
    const all = this.trials.flatMap((t) => this.samplesOf(t));
    this.nSamples = all.length;
    const c = this.h / 2;
    this.covered = new Set(all.map((s) => `${Math.floor(s.x / c)},${Math.floor(s.y / c)}`));
    if (all.length === 0) {
      this.cx = new Float64Array(n);
      this.cy = new Float64Array(n);
      return;
    }
    const { A, bx, by } = this.normalOf(all);
    const { cx, cy } = this.solve(A, this.regularizer(), this.params.smooth, bx, by);
    this.cx = cx;
    this.cy = cy;
  }

  /* ------------------------------------------------------------ 最適化 */

  /**
   * 交差検証（leave-one-trial-out）で、なめらかさ λ と強さを選ぶ。
   * 評価点ごとの誤差は |strength·D(他の試行だけで解いた場) − 目標変位|。
   */
  optimize(): OptResult {
    const n = this.nx * this.ny;
    const recent = this.trials.slice(-OPT_TRIALS);
    const per = recent.map((t) => {
      const s = this.samplesOf(t);
      return { s, ...this.normalOf(s) };
    });
    // 最適化に使わない古い試行も、学習データとしては常に含める
    const older = this.normalOf(this.trials.slice(0, -OPT_TRIALS).flatMap((t) => this.samplesOf(t)));
    const evalCount = per.reduce((c, p) => c + p.s.length, 0);
    const before = mean(per.flatMap((p) => p.s.map((s) => Math.hypot(s.dx, s.dy))));
    if (recent.length < 3 || evalCount === 0 || n === 0) {
      return { trials: this.trials.length, before, defaultErr: before, after: before, params: this.params };
    }
    const At = new Float64Array(older.A);
    const bxT = new Float64Array(older.bx);
    const byT = new Float64Array(older.by);
    for (const p of per) {
      for (let k = 0; k < n * n; k++) At[k] += p.A[k];
      for (let k = 0; k < n; k++) {
        bxT[k] += p.bx[k];
        byT[k] += p.by[k];
      }
    }
    const R = this.regularizer();
    // λ ごとに、各試行を抜いて解いた場で、その試行の点の予測変位を求める
    const cvPreds = (lambda: number) => {
      const preds: { s: Sample; d: [number, number] }[] = [];
      for (const p of per) {
        const A = new Float64Array(n * n);
        for (let k = 0; k < n * n; k++) A[k] = At[k] - p.A[k];
        const bx = new Float64Array(n);
        const by = new Float64Array(n);
        for (let k = 0; k < n; k++) {
          bx[k] = bxT[k] - p.bx[k];
          by[k] = byT[k] - p.by[k];
        }
        const { cx, cy } = this.solve(A, R, lambda, bx, by);
        for (const s of p.s) preds.push({ s, d: this.evalWith(cx, cy, s.x, s.y) });
      }
      return preds;
    };
    const errOf = (preds: { s: Sample; d: [number, number] }[], k: number) =>
      mean(preds.map(({ s, d }) => Math.hypot(k * d[0] - s.dx, k * d[1] - s.dy)));

    const defaultErr = errOf(cvPreds(DEFAULT_PARAMS.smooth), DEFAULT_PARAMS.strength);
    let best: Params = { ...DEFAULT_PARAMS };
    let bestErr = defaultErr;
    for (const smooth of SMOOTH_GRID) {
      const preds = cvPreds(smooth);
      for (const strength of STRENGTH_GRID) {
        const e = errOf(preds, strength);
        if (e < bestErr) {
          bestErr = e;
          best = { smooth, strength };
        }
      }
    }
    this.params = best;
    this.fit();
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

/* ================================================================ 数値計算・幾何 */

function cholesky(M: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
  }
  return L;
}
function cholSolve(L: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

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

type Match = { p: Pt; q: Pt; tx: number; ty: number; curv: number; u: number };

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
  for (const p of t.raw) {
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
    out.push({ p, q: path[idx], tx, ty, curv, u: idx / Math.max(1, n - 1) });
  }
  return out;
}
