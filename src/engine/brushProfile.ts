import type { StampFn } from './strokeRaster';
import { blendPixel, erasePixel } from './imageBuffer';

/**
 * 筆の「質感」を数値パラメータとして定義する（純TS・決定的）。
 *
 * 質感は 2 つの軸でできている:
 *   軸A（resolveProfile → strokeRaster が使う）: dab をどこに・どんな形で置くか
 *   軸B（createBrushStamp → StampFn が使う）  : 各画素にどう書き込むか
 *
 * 【なぜ「数値の束」なのか】
 * 質感を編集可能にするには、パラメータを op の params に焼き込む必要がある。
 * 描画時にグローバルな表を参照すると、ユーザーが設定を変えた瞬間に過去の op の
 * replay 結果まで変わってしまい、不変条件 state === replay(log) が壊れるため。
 * そこで「筆の形＝共通のカーネル関数」「筆の個性＝数値の束(BrushSettings)」に分け、
 * 数値だけを op が持ち運ぶ。BRUSH_DEFAULTS は UI の初期値（プリセット）にすぎない。
 *
 * 決定性の規約（これを破ると state === replay(log) が壊れる）:
 *   - 乱数は使わない。ムラは「絶対座標 (x,y) と seed の純関数」として作る。
 *     ストロークに沿った累積位相にすると、brush の consolidate（連続ストロークの点列連結）で
 *     「逐次適用 == 統合1回適用」のビット一致が崩れる。座標依存なら自動的に安全。
 *   - radiusAt は baseRadius を超えないこと（sizePressure/sizeCurve/speed はいずれも
 *     倍率 ≤1 にしかならない）。超えると createBrushOp の region と growBufferToInclude の
 *     pad（どちらも半径基準）が実際の描画範囲を下回り、描き残しが出る。
 *   - edge（AA幅）は 3px 以下に保つこと。stampCircle の内部高速パスがその前提で保守的になっている。
 */

export type BrushType = 'pen' | 'gpen' | 'pencil' | 'airbrush';

/**
 * 筆の調整可能なパラメータ。すべて数値なので op の params にそのまま焼き込める。
 * ここに無いもの（色・太さ・不透明度）はツール共通の設定として別に持つ。
 */
export interface BrushSettings {
  /** dab 間隔（その区間の半径に対する比）。小さいほど滑らかで重い。 */
  spacing: number;
  /** 硬い筆の縁のアンチエイリアス幅(px)。小さいほどシャープ。soft>0 のときは使わない。 */
  edge: number;
  /** 0 = 硬い縁。>0 でぼけた dab（エアブラシ）になり、大きいほど広くぼける。 */
  soft: number;
  /** 1 dab の濃度上限 0..1。小さいほど「重ねて濃くする」筆になる。 */
  flow: number;
  /** 筆圧が太さに効く量 0..1（0 = 太さが変わらない）。 */
  sizePressure: number;
  /** 太さの筆圧カーブ。大きいほど「軽く当てると極端に細い」（Gペン的）。 */
  sizeCurve: number;
  /** 筆圧が濃度に効く量 0..1。 */
  flowPressure: number;
  /** 紙目のムラの強さ 0..1（0 = ムラなし）。 */
  grain: number;
  /** 紙目の粒の大きさ(px)。 */
  grainScale: number;
  /**
   * 紙目の「窪み」しきい値 0..1。ノイズがこれ未満の画素にはインクが一切乗らない。
   * ムラを単なる濃度の掛け算にすると、1 ストローク内で重なる dab のブレンドが繰り返されて
   * 目が塗り潰され、ベタ塗りに近づく。乗らない画素を作ることで重ねても紙目が残り続ける。
   */
  grainFloor: number;
  /** 速く動かすほど細くする量 0..1（入り抜き）。0 = 速さを見ない。 */
  speed: number;
}

/**
 * 筆のプリセット（＝ UI の初期値）。描画はここを直接見ず、op に焼き込まれた
 * BrushSettings を見る。'pen' の値は「変更前とビット同一」の基準なので動かさない。
 */
export const BRUSH_DEFAULTS: Record<BrushType, BrushSettings> = {
  // ペン: 従来の挙動そのもの。spacing 0.35 / edge 1 / flow 1 / 筆圧は太さのみ線形。
  pen: {
    spacing: 0.35,
    edge: 1,
    soft: 0,
    flow: 1,
    sizePressure: 1,
    sizeCurve: 1,
    flowPressure: 0,
    grain: 0,
    grainScale: 1,
    grainFloor: 0,
    speed: 0,
  },
  // Gペン: しなる金属ペン先。太さの筆圧カーブが強く、速く走らせるほど細り、縁はシャープ。
  gpen: {
    spacing: 0.22,
    edge: 0.55,
    soft: 0,
    flow: 1,
    sizePressure: 0.9,
    sizeCurve: 1.8,
    flowPressure: 0,
    grain: 0,
    grainScale: 1,
    grainFloor: 0,
    speed: 1,
  },
  // 鉛筆: 太さは筆圧であまり変わらず濃さが変わる。紙目の窪みにはインクが乗らない。
  pencil: {
    spacing: 0.28,
    edge: 1.1,
    soft: 0,
    flow: 0.8,
    sizePressure: 0.4,
    sizeCurve: 1,
    flowPressure: 0.775,
    grain: 0.6,
    grainScale: 2,
    grainFloor: 0.38,
    speed: 0,
  },
  // エアブラシ: 縁がぼけた低濃度の dab を細かい間隔で置き、重なりで濃度を作る（buildup）。
  airbrush: {
    spacing: 0.1,
    edge: 1,
    soft: 0.5,
    flow: 0.07,
    sizePressure: 0.25,
    sizeCurve: 1,
    flowPressure: 0.7,
    grain: 0,
    grainScale: 1,
    grainFloor: 0,
    speed: 0,
  },
};

/** UI が出すスライダーの定義（順番もこの通りに並べる）。 */
export const BRUSH_SETTING_FIELDS: {
  key: keyof BrushSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  { key: 'spacing', label: '間隔', min: 0.05, max: 0.8, step: 0.01, hint: 'dab の間隔（半径比）。小さいほど滑らかで重い' },
  { key: 'flow', label: '濃度', min: 0.02, max: 1, step: 0.01, hint: '1 dab の濃さ。小さいほど「重ねて濃くする」筆になる' },
  { key: 'soft', label: 'ぼかし', min: 0, max: 1, step: 0.05, hint: '0 = 硬い縁。0 より上げると縁がぼけ、さらに上げるほどインクが芯へ寄って裾が淡くなる' },
  { key: 'edge', label: '縁の締まり', min: 0.3, max: 3, step: 0.05, hint: '硬い縁のアンチエイリアス幅(px)。小さいほどシャープ（ぼかし>0 では無効）' },
  { key: 'sizePressure', label: '筆圧→太さ', min: 0, max: 1, step: 0.05, hint: '筆圧が太さに効く量' },
  { key: 'sizeCurve', label: '太さカーブ', min: 0.5, max: 3, step: 0.1, hint: '大きいほど「軽く当てると極端に細い」（Gペン的）' },
  { key: 'flowPressure', label: '筆圧→濃度', min: 0, max: 1, step: 0.05, hint: '筆圧が濃さに効く量' },
  { key: 'speed', label: '速度で細る', min: 0, max: 1, step: 0.05, hint: '速く動かすほど細くする（入り抜き）' },
  { key: 'grain', label: '紙目の濃淡', min: 0, max: 1, step: 0.05, hint: '紙目に沿った濃さのムラの強さ（抜けは作らない）' },
  { key: 'grainFloor', label: '紙目の抜け', min: 0, max: 0.8, step: 0.02, hint: 'インクが乗らない窪みの割合。重ね塗りでも埋まらない抜けになる（濃淡とは独立に効く）' },
  { key: 'grainScale', label: '紙目の粒', min: 1, max: 8, step: 0.5, hint: 'ザラつきの粒の大きさ(px)' },
];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 未知/未指定は従来のペンへ倒す（brushType/brush を持たない既存ログもそのまま replay できる）。 */
export function brushSettings(type?: BrushType, override?: BrushSettings): BrushSettings {
  return override ?? BRUSH_DEFAULTS[type ?? 'pen'] ?? BRUSH_DEFAULTS.pen;
}

/** 2つの設定が同値か（consolidate / sameParams 用）。 */
export function sameSettings(a: BrushSettings, b: BrushSettings): boolean {
  for (const k of Object.keys(BRUSH_DEFAULTS.pen) as (keyof BrushSettings)[]) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// ---- 軸A: dab の置き方 ------------------------------------------------------

/** rasterizer が使う形（BrushSettings から組み立てる。数値以外はここでしか作らない）。 */
export interface BrushProfile {
  radiusAt(baseRadius: number, pressure: number): number;
  spacingRatio: number;
  edge: number;
  falloff?: (t: number) => number;
  flowAt(pressure: number): number;
  speedFactor?: (dist: number) => number;
}

/** ぼかし減衰のルックアップ表の分割数。pow を画素ごとに呼ばないための量子化（決定的）。 */
const FALLOFF_LUT = 256;

/**
 * 数値設定 → rasterizer が使うプロファイル。
 * 既定のペン設定を入れると、変更前の式とビット同一になるよう組んである:
 *   radiusAt = r*(1-1 + 1*p^1) = r*p / flowAt = 1*(1-0+0) = 1 / edge=1 / falloff なし。
 */
export function resolveProfile(s: BrushSettings): BrushProfile {
  const curve = s.sizeCurve;
  const sp = s.sizePressure;
  const fp = s.flowPressure;
  const flow = s.flow;
  const speed = s.speed;

  let falloff: ((t: number) => number) | undefined;
  if (s.soft > 0) {
    // (1-t)^k の k を上げるほど中心から急に落ちる＝芯が小さく裾が長い＝ぼけて見える。
    // soft を上げたら必ずぼける（単調）ようにこの向きで対応させる。
    const k = clamp(0.6 + s.soft * 2.9, 0.4, 4);
    const lut = new Float64Array(FALLOFF_LUT + 1);
    for (let i = 0; i <= FALLOFF_LUT; i++) lut[i] = Math.pow(1 - i / FALLOFF_LUT, k);
    falloff = (t) => lut[(t * FALLOFF_LUT) | 0];
  }

  return {
    radiusAt: (r, p) => r * (1 - sp + sp * (curve === 1 ? p : Math.pow(p, curve))),
    spacingRatio: s.spacing,
    edge: s.edge,
    falloff,
    flowAt: (p) => flow * (1 - fp + fp * p * p),
    speedFactor:
      speed > 0 ? (dist) => clamp(1 - speed * (1 - 1 / (1 + dist / 26)), 0.2, 1) : undefined,
  };
}

// ---- 軸B: 画素への書き込み --------------------------------------------------

/**
 * 紙目のシード。紙は「そこにある」ものなのでストロークごとには変えない。
 * 固定にすることで (1) 重ね塗りで同じ目が出て紙らしく見え、(2) 連続ストロークの
 * consolidate が seed 不一致で弾かれずに済む。
 */
export const PAPER_SEED = 20260729;

/** 32bit 整数ハッシュ。整数演算だけなので環境によらず同じ値になる（0..1）。 */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/**
 * 紙目（バイリニア補間の value noise, 0..1）。scale は粒の大きさ(px)。
 * 画素ごとの白色雑音だと砂嵐に見えるので、格子点を smoothstep で補間して粒を作る。
 */
export function paperGrain(x: number, y: number, seed: number, scale: number): number {
  const fx = x / scale;
  const fy = y / scale;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  const a = n00 + (n10 - n00) * sx;
  const b = n01 + (n11 - n01) * sx;
  return a + (b - a) * sy;
}

/**
 * 画素への書き込み関数を作る。op の apply とライブプレビューが必ず同じものを使うため、
 * ここ 1 か所で組み立てる（別々に組むとプレビューと確定結果がずれる）。
 */
export function createBrushStamp(
  color: [number, number, number],
  opacity: number,
  s: BrushSettings,
  seed: number,
): StampFn {
  const [r, g, b] = color;
  // 濃淡(grain)と抜け(grainFloor)は独立に効く。どちらも 0 のときだけ紙目の計算を丸ごと省く。
  if (s.grain <= 0 && s.grainFloor <= 0) {
    return (buf, x, y, cov) => blendPixel(buf, x, y, r, g, b, opacity * cov);
  }
  const depth = s.grain;
  const scale = s.grainScale;
  const floor = s.grainFloor;
  const base = 1 - depth;
  const invSpan = floor < 1 ? 1 / (1 - floor) : 0;
  return (buf, x, y, cov) => {
    const n = paperGrain(x, y, seed, scale);
    if (n <= floor) return; // 紙の窪み: 何度重ねてもインクが乗らない（目が残り続ける）
    const tooth = (n - floor) * invSpan; // 窪みの上を 0..1 へ引き伸ばす
    blendPixel(buf, x, y, r, g, b, opacity * cov * (base + depth * tooth));
  };
}

/**
 * 「透明色」で描くときの書き込み関数。createBrushStamp と同じ質感の計算をして、
 * 色を置く代わりにアルファを削る（destination-out）。
 * 筆の性格（軸A: dab の置き方）は resolveProfile がそのまま担うので、
 * この 2 つを組み合わせると「ブラシがその質感のまま消しゴムになる」動きになる。
 *
 * 既定のペン設定（grain=0, grainFloor=0）では単純な erasePixel に落ちるため、
 * 従来の消しゴム（質感を持たない硬い円）とビット同一のまま。
 */
export function createEraseStamp(opacity: number, s: BrushSettings, seed: number): StampFn {
  if (s.grain <= 0 && s.grainFloor <= 0) {
    return (buf, x, y, cov) => erasePixel(buf, x, y, opacity * cov);
  }
  const depth = s.grain;
  const scale = s.grainScale;
  const floor = s.grainFloor;
  const base = 1 - depth;
  const invSpan = floor < 1 ? 1 / (1 - floor) : 0;
  return (buf, x, y, cov) => {
    const n = paperGrain(x, y, seed, scale);
    if (n <= floor) return; // 窪みには消しゴムも届かない（鉛筆の粒が少し残る）
    const tooth = (n - floor) * invSpan;
    erasePixel(buf, x, y, opacity * cov * (base + depth * tooth));
  };
}
