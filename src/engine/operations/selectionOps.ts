import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { combineSelection, rasterizePolygon, selectionBounds, type SelectionMode } from '../selection';
import { clampBBox, fullCanvas, unionBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * 選択範囲の操作（klass=edit）。画素は一切変えず、EditorState.selection だけを差し替える。
 *
 * op が持つのは多角形の点列だけで、マスクは apply のたびに焼き直す。これにより
 *   - ログが軽い（マスク画素を持ち歩かない）
 *   - state === replay(log) が選択範囲まで含めて成立する
 * の両方が成り立つ。Undo/Redo も他の操作と同じ仕組みでそのまま効く。
 */
export interface SetSelectionParams {
  /** 多角形の点列。キャンバス座標の平坦配列 [x0,y0,x1,y1,...]（閉じているものとして扱う）。 */
  path: number[];
  /** 既存の選択との合成方法。 */
  mode: SelectionMode;
}

export const setSelectionHandler: OpHandler = {
  type: 'setSelection',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const p = op.params as unknown as SetSelectionParams;
    const shape = rasterizePolygon(p.path, state.width, state.height);
    return { ...state, selection: combineSelection(state.selection, shape, p.mode ?? 'replace') };
  },

  // 選択は「最後に指定したものが現在の選択」…ではない（add/subtract は履歴に意味がある）ので統合しない。
};

export const clearSelectionHandler: OpHandler = {
  type: 'clearSelection',
  klass: 'edit',

  apply(state: EditorState, _op: Operation): EditorState {
    if (!state.selection) return state;
    return { ...state, selection: null };
  },
};

/**
 * 多角形で選択範囲を作る op。region には「変化しうる範囲」＝新しい形と既存選択の和を入れる
 * （マーチングアンツの再描画範囲として使う。画素は変わらない）。
 */
export function createSetSelectionOp(
  path: readonly number[],
  mode: SelectionMode,
  state: EditorState,
  width: number,
  height: number,
): Operation {
  const shape = rasterizePolygon(path, width, height);
  let region: BBox = shape ? selectionBounds(shape) : { x: 0, y: 0, w: 0, h: 0 };
  if (state.selection) region = unionBBox(region, selectionBounds(state.selection));
  return {
    id: genId('setSelection'),
    type: 'setSelection',
    klass: 'edit',
    params: { path: [...path], mode },
    region: clampBBox(region, width, height),
    layerId: '', // ドキュメント全体の状態（レイヤーに属さない）
    timestamp: Date.now(),
  };
}

/** 選択を解除する op。 */
export function createClearSelectionOp(width: number, height: number): Operation {
  return {
    id: genId('clearSelection'),
    type: 'clearSelection',
    klass: 'edit',
    params: {},
    region: fullCanvas(width, height),
    layerId: '',
    timestamp: Date.now(),
  };
}
