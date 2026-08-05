import type { EditorState, Layer, LayerNode } from '../types';
import { buffersEqual } from './imageBuffer';
import { isGroup } from './layer';
import { selectionsEqual } from './selection';

/**
 * 2つの EditorState がビット同一か。レイヤーツリー（フォルダ含む）を再帰比較し、
 * バッファ・オフセット・可視性・不透明度・グループ構造・選択範囲まで見る。
 * replay の往復一致検証（Phase 2 受け入れ条件）に使用する。
 */
export function statesEqual(a: EditorState, b: EditorState): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  // 選択範囲も state の一部（描ける場所を変える）。log から同じマスクが焼き直せることを確かめる。
  if (!selectionsEqual(a.selection, b.selection)) return false;
  return nodesEqual(a.layers, b.layers);
}

function nodesEqual(a: LayerNode[], b: LayerNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const na = a[i];
    const nb = b[i];
    if (na.id !== nb.id || na.name !== nb.name) return false;
    if (na.visible !== nb.visible || na.opacity !== nb.opacity) return false;
    const ga = isGroup(na);
    const gb = isGroup(nb);
    if (ga !== gb) return false;
    if (ga && gb) {
      if (na.collapsed !== nb.collapsed) return false;
      // 横軸（差分スタック）か否かと、いま出ている差分まで一致していること。
      // undefined（通常フォルダ）と 0（1つ目の差分を表示中）は別物なので生値で比べる。
      if (na.variantIndex !== nb.variantIndex) return false;
      if (!nodesEqual(na.children, nb.children)) return false;
    } else {
      const la = na as Layer;
      const lb = nb as Layer;
      if (la.offsetX !== lb.offsetX || la.offsetY !== lb.offsetY) return false;
      if ((la.clipped ?? false) !== (lb.clipped ?? false)) return false;
      if (!buffersEqual(la.buffer, lb.buffer)) return false;
    }
  }
  return true;
}
