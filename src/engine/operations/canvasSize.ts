import type { EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

/**
 * キャンバス（アートボード）サイズ変更操作（klass=edit）。
 * レイヤーの buffer/offset は一切触らず、アートボード矩形 [0,0,w,h] の大きさ（＝flatten のクリップ範囲）
 * だけを変える非破壊リサイズ。縮小すると枠外に隠れ、拡大すると再び現れる（内容は消えない）。
 *
 * これをログに積むことで不変条件 state === replay(log) が保たれる（Replayer は元サイズの初期状態から
 * replay し、この op で現在サイズへ到達する）。Undo/Verify もそのまま成立する。
 */
export interface CanvasSizeParams {
  width: number;
  height: number;
}

export const canvasSizeHandler: OpHandler = {
  type: 'canvasSize',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const p = op.params as unknown as CanvasSizeParams;
    return { ...state, width: p.width, height: p.height };
  },

  // サイズ変更は逐次でも最新値がそのまま最終値なので統合可能（連続変更を1つに畳む）。
  consolidate(_prev: Operation, next: Operation): Operation | null {
    return next;
  },
};

/** アートボードを w×h に変更する op を作る。 */
export function createSetCanvasSizeOp(width: number, height: number): Operation {
  const params: CanvasSizeParams = { width, height };
  return {
    id: genId('canvasSize'),
    type: 'canvasSize',
    klass: 'edit',
    params: params as unknown as Record<string, unknown>,
    region: fullCanvas(width, height),
    layerId: '',
    timestamp: Date.now(),
  };
}
