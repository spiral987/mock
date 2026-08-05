/**
 * 選択範囲の境界＝マーチングアンツ（流れる点線）の描画。
 *
 * CanvasEditor から切り出してあるのは、見た目の要（くっきりさと「動いて見えるか」）が
 * 座標と位相の細かい詰めで決まり、単体で目視確認したいため。描画以外の状態は持たない。
 *
 * 【なぜ黒と白を交互に置くのか】
 * 「黒の実線の上に白の破線」を重ねると、白い紙の上では白が見えず連続した1本の線に見え、
 * 破線がまったく流れて見えない。線上のどの点も必ず黒か白のどちらかになるよう、
 * 同じ破線パターンを半周期ずらして2回引く。
 *
 * 【なぜ半画素ずらすのか】
 * 輪郭は画素の境界（整数座標）を通る。そこへ幅1の線を引くと左右2列に 50% ずつ乗って
 * 薄い灰色の線になる。半画素ずらして画素の中心に載せると、くっきり1画素の線になる。
 */

/** 破線1本ぶんを何ティックかけて流すか（大きいほど滑らかに、ゆっくり動く）。 */
export const ANTS_STEPS = 4;

/** 破線1本の長さ（キャンバス画素）。拡大時に1画素を割るとぼやけるので下限を付ける。 */
export function antsDash(zoom: number): number {
  return Math.max(4, 4 / zoom);
}

/** 線の太さ（キャンバス画素）。同じ理由で 1 画素を下限にする。 */
export function antsLineWidth(zoom: number): number {
  return Math.max(1, 1 / zoom);
}

export interface AntsOptions {
  /** 輪郭ループ（キャンバス座標の平坦配列）の配列。traceSelectionOutline の戻り値。 */
  loops: number[][];
  /** 表示倍率。canvas は CSS で拡大されるので、線幅・破線をこれで補正する。 */
  zoom: number;
  /** アニメーション位相 0..ANTS_STEPS*2-1。 */
  phase: number;
  /** キャンバスの大きさ（端の辺をはみ出させないためのクランプに使う）。 */
  width: number;
  height: number;
}

export function drawMarchingAnts(ctx: CanvasRenderingContext2D, o: AntsOptions): void {
  if (o.loops.length === 0) return;
  const z = o.zoom || 1;
  const dash = antsDash(z);

  // 半画素ずらして画素の中心へ。端の辺はキャンバス外へ出ないよう内側へ寄せる。
  const hx = (v: number) => Math.min(o.width - 0.5, v + 0.5);
  const hy = (v: number) => Math.min(o.height - 0.5, v + 0.5);
  const path = new Path2D();
  for (const pts of o.loops) {
    path.moveTo(hx(pts[0]), hy(pts[1]));
    for (let i = 2; i < pts.length; i += 2) path.lineTo(hx(pts[i]), hy(pts[i + 1]));
  }

  // パスの始点が半画素位置(x+0.5)なので、破線の切れ目もそのままだと半画素位置に来て
  // 黒と白の継ぎ目が 1px グレーに滲む。0.5 ずらして切れ目を画素の境界に合わせる。
  const shift = o.phase * (dash / ANTS_STEPS) + 0.5;
  ctx.save();
  ctx.lineWidth = antsLineWidth(z);
  ctx.lineCap = 'butt'; // round にすると隣の破線とにじんで黒白の境目が濁る
  ctx.setLineDash([dash, dash]);
  ctx.strokeStyle = '#000';
  ctx.lineDashOffset = -shift;
  ctx.stroke(path);
  ctx.strokeStyle = '#fff';
  ctx.lineDashOffset = -shift + dash; // 黒の隙間をちょうど埋める位相
  ctx.stroke(path);
  ctx.restore();
}
