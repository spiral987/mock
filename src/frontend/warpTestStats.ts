import type { PathKind, Pt } from './warpField';
import { resample } from './warpPaths';
import type { WarpMethod } from './warpMethod';

/**
 * 効果測定（③）の指標計算・集計・CSV。
 * 指標はすべてキャンバス座標（px）で、「画面に表示された線」（補正ありなら補正後の線）に対して計算する。
 */

export type Cond = 'off' | 'on';
export const COND_LABEL: Record<Cond, string> = { off: '補正なし', on: '補正あり' };
export const KIND_JA: Record<PathKind, string> = { line: '直線', arc: '円弧', s: 'S字' };

/** 1 本分の記録（練習は記録しない）。 */
export type TrialRecord = {
  no: number; // 試行番号（1〜24）
  half: 1 | 2; // 前半 / 後半
  lineId: string; // 目標線の番号（L01〜L12）。同じ番号 = 同じ目標線
  kind: PathKind;
  cond: Cond;
  method: WarpMethod; // 実験方式（A＝キャンバス固定・視点操作なし、B＝入力座標系固定・視点操作あり）
  meanDev: number; // 平均偏差 [px]
  endErr: number; // 終点のずれ [px]
  durationSec: number; // 描画時間 [s]
  retries: number; // 短すぎてやり直した回数
  strength: number; // 補正の強さ（テスト開始時の値で固定）
  smooth: number; // 補正のなめらかさ λ（参考）
  viewScale: number; // 描いた時点の表示：キャンバス px / 画面 px
  viewRotation: number; // 描いた時点の表示の回転 [度]
  pointerType: string;
  time: string;
};

function nearest(p: Pt, pts: Pt[]): number {
  let m = Infinity;
  for (const q of pts) {
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}
export const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * 平均偏差：描いた線と目標線のズレ。
 *   (描いた線の各点 → 目標線までの距離の平均 + 目標線の各点 → 描いた線までの距離の平均) / 2
 * 片方向だけだと、途中までしか描かなかった線のズレを見逃すため両方向で測る。
 * 線は長さに沿って 2px ごとに打ち直してから計算する（ゆっくり描いた所に点が偏らないように）。
 */
export function meanDeviation(stroke: Pt[], target: Pt[]): number {
  const s = resample(stroke, 2);
  const t = resample(target, 2);
  return (mean(s.map((q) => nearest(q, t))) + mean(t.map((q) => nearest(q, s)))) / 2;
}

/** 終点のずれ：描き終えた点と目標線の終点との距離。 */
export function endError(stroke: Pt[], target: Pt[]): number {
  const E = stroke[stroke.length - 1];
  const B = target[target.length - 1];
  return Math.hypot(E.x - B.x, E.y - B.y);
}

/** 条件ごとの平均。 */
export function summarize(records: TrialRecord[]) {
  const by = (c: Cond) => records.filter((r) => r.cond === c);
  const row = (rs: TrialRecord[]) => ({
    n: rs.length,
    meanDev: mean(rs.map((r) => r.meanDev)),
    endErr: mean(rs.map((r) => r.endErr)),
    durationSec: mean(rs.map((r) => r.durationSec)),
  });
  return { off: row(by('off')), on: row(by('on')) };
}

/** 目標線ごとに、補正なし・ありを並べる（両方そろった線だけ）。 */
export function byLine(records: TrialRecord[]) {
  const map = new Map<string, { kind: PathKind; off?: TrialRecord; on?: TrialRecord }>();
  for (const r of records) {
    const e = map.get(r.lineId) ?? { kind: r.kind };
    e[r.cond] = r;
    map.set(r.lineId, e);
  }
  return [...map.entries()]
    .filter(([, e]) => e.off && e.on)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lineId, e]) => ({ lineId, kind: e.kind, off: e.off!, on: e.on! }));
}

/** CSV（1 試行 1 行）。 */
export function toCsv(records: TrialRecord[]): string {
  const cols: [string, (r: TrialRecord) => string | number][] = [
    ['trial_no', (r) => r.no],
    ['half', (r) => r.half],
    ['line_id', (r) => r.lineId],
    ['kind', (r) => r.kind],
    ['method', (r) => r.method],
    ['condition', (r) => r.cond],
    ['mean_dev_px', (r) => r.meanDev.toFixed(2)],
    ['end_err_px', (r) => r.endErr.toFixed(2)],
    ['duration_s', (r) => r.durationSec.toFixed(3)],
    ['retries', (r) => r.retries],
    ['strength', (r) => r.strength],
    ['smooth', (r) => r.smooth],
    ['view_scale', (r) => r.viewScale.toFixed(4)],
    ['view_rotation_deg', (r) => r.viewRotation.toFixed(1)],
    ['pointer_type', (r) => r.pointerType],
    ['timestamp', (r) => r.time],
  ];
  const lines = [cols.map((c) => c[0]).join(',')];
  for (const r of records) lines.push(cols.map((c) => String(c[1](r))).join(','));
  return lines.join('\n');
}
