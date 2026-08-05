import type { BBox, EditorState, Layer, LayerGroup, LayerNode, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getNode, getParentInfo, removeNode } from '../editorState';
import {
  isGroup,
  isVariantStack,
  variantIndexOf,
  activeVariant,
  createVariantStack,
  createLayer,
  cloneLayer,
  collectLeafIds,
  collectNodeIds,
  firstLeafId,
} from '../layer';
import { genId } from '../../util/id';

/**
 * レイヤーの「横軸」＝差分スタック(variant stack)を操作する op 群（klass=edit）。
 *
 * モデル: 1 つのスロットに互いに排他な差分を左右に並べ、children[variantIndex] だけが
 * そこに在る（合成に出る）。他の差分は独立に存在するだけで、同時には現れない。
 * スタックは LayerGroup の一種なので、スロットごとの移動・削除・D&D は既存の
 * moveNode / removeLayer がそのまま使える。ここで足すのは横軸そのものの操作だけ:
 *   addVariant       … スロットを横軸化し、新しい差分を右隣に足す
 *   setVariantIndex  … 左右にスライドして並列の差分を出す
 *   removeVariant    … 差分を1つ捨てる（残り1つになったら横軸を解いて元のレイヤーに戻す）
 *
 *   moveAsVariant    … 既存のレイヤーを別のスロットの左右へ移し、その場で差分にする
 *
 * すべて log に記録され replay で決定的に再構築できる（不変条件 state === replay(log)）。
 * 生成される id はすべて params に焼き込む（replay 時も同一 id で再現するため）。
 */

const EMPTY: BBox = { x: 0, y: 0, w: 0, h: 0 };

/** ノード配列の中の id を、置換関数の結果（null なら削除）で差し替えた新しい木を返す。 */
function replaceInTree(
  nodes: LayerNode[],
  id: string,
  fn: (n: LayerNode) => LayerNode | null,
): LayerNode[] {
  const out: LayerNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      const r = fn(n);
      if (r) out.push(r);
      continue;
    }
    out.push(isGroup(n) ? { ...n, children: replaceInTree(n.children, id, fn) } : n);
  }
  return out;
}

/** そのスロットに出ている最初のリーフ id（アクティブレイヤーの付け替え先）。 */
function activeLeafOf(node: LayerNode): string | undefined {
  if (isVariantStack(node)) {
    const v = activeVariant(node);
    return v ? activeLeafOf(v) : undefined;
  }
  if (isGroup(node)) return firstLeafId(node.children);
  return node.id;
}

// ---- 差分を足す（＝スロットを横軸化する） ----------------------------------
export interface AddVariantParams {
  /** 横軸を足す対象。いまそのスロットに出ているノード（リーフ or フォルダ）。 */
  nodeId: string;
  /** 新しく作るスタックの id（対象が既に横軸の中なら未使用）。 */
  stackId: string;
  /** 新しい差分レイヤーの id。 */
  variantId: string;
  name: string;
  /** true なら「いまの差分の複製」を、false なら空レイヤーを新しい差分にする。 */
  copy: boolean;
}

export const addVariantHandler: OpHandler = {
  type: 'addVariant',
  klass: 'edit',
  apply(state, op) {
    const { nodeId, stackId, variantId, name, copy } = op.params as unknown as AddVariantParams;
    if (getNode(state, variantId)) return state; // 冪等
    const node = getNode(state, nodeId);
    if (!node) return state;

    // 新しい差分の中身。複製はリーフのみ（フォルダの複製は子孫 id の再採番が要るので対象外）。
    const makeVariant = (from: LayerNode): Layer =>
      copy && !isGroup(from)
        ? { ...cloneLayer(from), id: variantId, name }
        : createLayer(variantId, name, state.width, state.height);

    const info = getParentInfo(state, nodeId);
    if (!info) return state;
    const parent = info.parentId ? getNode(state, info.parentId) : null;

    // (a) 既に横軸の中に居る → そのスタックの、いまの差分の右隣に足す。
    if (parent && isVariantStack(parent)) {
      const stack = parent;
      const at = variantIndexOf(stack);
      if (at < 0) return state;
      const variant = makeVariant(stack.children[at]);
      const children = [...stack.children];
      children.splice(at + 1, 0, variant);
      const layers = replaceInTree(state.layers, stack.id, () => ({
        ...stack,
        children,
        variantIndex: at + 1,
      }));
      return { ...state, layers, activeLayerId: variantId };
    }

    // (a') 対象がスロットそのもの → そのスロットに 1 枚足す（横軸の中に横軸は作らない）。
    if (isVariantStack(node)) {
      const at = variantIndexOf(node);
      if (at < 0) return state;
      const variant = makeVariant(node.children[at]);
      const children = [...node.children];
      children.splice(at + 1, 0, variant);
      const layers = replaceInTree(state.layers, node.id, () => ({
        ...node,
        children,
        variantIndex: at + 1,
      }));
      return { ...state, layers, activeLayerId: variantId };
    }

    // (b) まだ縦軸だけ → その場でスタックに包み、対象を 1 つ目の差分にして右隣に足す。
    if (getNode(state, stackId)) return state; // id 衝突（冪等側に倒す）
    const variant = makeVariant(node);
    const layers = replaceInTree(state.layers, nodeId, (n) =>
      createVariantStack(stackId, [n, variant], 1),
    );
    return { ...state, layers, activeLayerId: variantId };
  },

  // 差分追加は統合しない（構造が増える操作）。
};

export function createAddVariantOp(
  nodeId: string,
  stackId: string,
  variantId: string,
  name: string,
  copy: boolean,
  region?: BBox,
): Operation {
  return {
    id: genId('addVariant'),
    type: 'addVariant',
    klass: 'edit',
    params: { nodeId, stackId, variantId, name, copy },
    region: region ?? EMPTY,
    layerId: variantId,
    timestamp: Date.now(),
  };
}

// ---- 既存レイヤーを隣へ移して差分にする（D&D で行の左右へ落とす） -----------

/**
 * 差分が 1 つだけになったスタックを解いて、素のノードへ戻す（木全体を正規化する）。
 * スタックは「複数の案を並べるスロット」なので、1 つしか無いなら存在意義が無い。
 * removeVariant が最後の 1 つで横軸を解くのと同じ規則を、取り外し経路にも適用する。
 */
function unwrapThinStacks(nodes: LayerNode[]): LayerNode[] {
  return nodes.map((n) => {
    if (!isGroup(n)) return n;
    const children = unwrapThinStacks(n.children);
    if (isVariantStack(n) && children.length === 1) return children[0];
    return { ...n, children };
  });
}

export interface MoveAsVariantParams {
  /** 動かすノード（レイヤー / フォルダ / スタックまるごと）。 */
  nodeId: string;
  /** 落とし先のスロット。 */
  targetId: string;
  /** 落とし先がまだ横軸でないとき、新しく作るスタックの id（replay 用に焼き込む）。 */
  stackId: string;
  /** 落とし先から見て左右どちらへ差し込むか（右ほど variantIndex が大きい）。 */
  side: 'left' | 'right';
}

export const moveAsVariantHandler: OpHandler = {
  type: 'moveAsVariant',
  klass: 'edit',
  apply(state, op) {
    const { nodeId, targetId, stackId, side } = op.params as unknown as MoveAsVariantParams;
    if (nodeId === targetId) return state;
    const node = getNode(state, nodeId);
    const target = getNode(state, targetId);
    if (!node || !target) return state;
    if (collectNodeIds(node).includes(targetId)) return state; // 自分の子孫の隣へは動かせない

    // スタックをスタックの隣へ落としたときは、入れ子にせず中身を平らに混ぜる
    // （どちらも「互いに排他な案の集合」なので、合わせて 1 つの集合になるのが自然）。
    const incoming: LayerNode[] = isVariantStack(node) ? node.children : [node];
    if (incoming.length === 0) return state;

    // (a) すでに同じスタックの中に居る同士 → その中での並べ替え（スタックの id を保つ）。
    const nInfo = getParentInfo(state, nodeId);
    const tInfo = getParentInfo(state, targetId);
    if (nInfo && tInfo && nInfo.parentId && nInfo.parentId === tInfo.parentId) {
      const parent = getNode(state, nInfo.parentId);
      if (parent && isVariantStack(parent)) {
        const children = parent.children.filter((c) => c.id !== nodeId);
        let to = children.findIndex((c) => c.id === targetId);
        if (to < 0) return state;
        if (side === 'right') to += 1;
        children.splice(to, 0, node);
        const layers = replaceInTree(state.layers, parent.id, () => ({
          ...parent,
          children,
          variantIndex: to,
        }));
        return { ...state, layers, activeLayerId: activeLeafOf(node) ?? state.activeLayerId };
      }
    }

    // (b) いまの場所から取り外す（残り 1 つになったスタックは解く）。
    const detached = removeNode(state.layers, nodeId);
    if (!detached.removed) return state;
    let layers = unwrapThinStacks(detached.tree);

    // 取り外しで木が変わるので、落とし先が残っていることを確かめ直す。
    const dest = getNode({ ...state, layers }, targetId);
    if (!dest) return state;

    let shown: LayerNode;
    if (isVariantStack(dest)) {
      // (c) すでに横軸のスロット → いま出ている差分の隣へ差し込む。
      const at = variantIndexOf(dest);
      const insert = side === 'right' ? at + 1 : at;
      const children = [...dest.children];
      children.splice(insert, 0, ...incoming);
      layers = replaceInTree(layers, dest.id, () => ({ ...dest, children, variantIndex: insert }));
      shown = children[insert];
    } else {
      // (d) まだ縦軸だけ → その場で横軸化し、落とした側を表示中の差分にする。
      if (getNode({ ...state, layers }, stackId)) return state; // id 衝突（冪等側へ倒す）
      const children = side === 'right' ? [dest, ...incoming] : [...incoming, dest];
      const index = side === 'right' ? 1 : 0;
      layers = replaceInTree(layers, targetId, () => createVariantStack(stackId, children, index));
      shown = children[index];
    }
    // 落としたものをそのまま表示中の差分にするので、結果が即座に見える。
    return { ...state, layers, activeLayerId: activeLeafOf(shown) ?? state.activeLayerId };
  },

  // 構造が変わる操作なので統合しない。
};

export function createMoveAsVariantOp(
  nodeId: string,
  targetId: string,
  stackId: string,
  side: 'left' | 'right',
  region?: BBox,
): Operation {
  return {
    id: genId('moveAsVariant'),
    type: 'moveAsVariant',
    klass: 'edit',
    params: { nodeId, targetId, stackId, side },
    region: region ?? EMPTY,
    layerId: nodeId,
    timestamp: Date.now(),
  };
}

// ---- 左右にスライド（並列の差分を出す） -------------------------------------
export interface SetVariantIndexParams {
  stackId: string;
  index: number;
}

export const setVariantIndexHandler: OpHandler = {
  type: 'setVariantIndex',
  klass: 'edit',
  apply(state, op) {
    const { stackId, index } = op.params as unknown as SetVariantIndexParams;
    const stack = getNode(state, stackId);
    if (!stack || !isVariantStack(stack)) return state;
    const next = Math.max(0, Math.min(stack.children.length - 1, Math.trunc(index)));
    if (next === variantIndexOf(stack)) return state;
    const updated: LayerGroup = { ...stack, variantIndex: next };
    const layers = replaceInTree(state.layers, stackId, () => updated);
    // 描いていた差分が引っ込んだら、いま出てきた差分を描画対象にする（描き先を見失わせない）。
    let activeLayerId = state.activeLayerId;
    if (collectLeafIds(stack).includes(activeLayerId)) {
      activeLayerId = activeLeafOf(updated) ?? activeLayerId;
    }
    return { ...state, layers, activeLayerId };
  },
  // 絶対値セットなので連続適用は last-wins と等価（スライドの連打を 1 op に畳める）。
  consolidate: (prev, next) =>
    prev.layerId === next.layerId
      ? { ...prev, params: next.params, timestamp: next.timestamp }
      : null,
};

export function createSetVariantIndexOp(stackId: string, index: number, region?: BBox): Operation {
  return {
    id: genId('setVariantIndex'),
    type: 'setVariantIndex',
    klass: 'edit',
    params: { stackId, index },
    region: region ?? EMPTY,
    layerId: stackId,
    timestamp: Date.now(),
  };
}

// ---- 差分を1つ捨てる（残り1つなら横軸を解く） -------------------------------
export interface RemoveVariantParams {
  stackId: string;
  variantId: string;
}

export const removeVariantHandler: OpHandler = {
  type: 'removeVariant',
  klass: 'edit',
  apply(state, op) {
    const { stackId, variantId } = op.params as unknown as RemoveVariantParams;
    const stack = getNode(state, stackId);
    if (!stack || !isVariantStack(stack)) return state;
    const at = stack.children.findIndex((c) => c.id === variantId);
    if (at < 0 || stack.children.length < 2) return state; // 最後の1つは removeLayer 側の仕事
    const removed = stack.children[at];
    const totalLeaves = state.layers.flatMap(collectLeafIds).length;
    if (totalLeaves - collectLeafIds(removed).length < 1) return state; // 最低1リーフは残す

    const children = stack.children.filter((_, i) => i !== at);
    const cur = variantIndexOf(stack);
    // 捨てた差分より左を見ていたらそのまま、それ以外は同じ位置（右端なら 1 つ左）へ寄せる。
    const nextIndex = cur > at ? cur - 1 : Math.min(cur, children.length - 1);

    // 残り 1 つになったら横軸は無意味なので解いて、素のノードをそのスロットに戻す。
    const replacement: LayerNode =
      children.length === 1 ? children[0] : { ...stack, children, variantIndex: nextIndex };
    const layers = replaceInTree(state.layers, stackId, () => replacement);

    let activeLayerId = state.activeLayerId;
    if (collectLeafIds(removed).includes(activeLayerId)) {
      activeLayerId = activeLeafOf(replacement) ?? firstLeafId(layers) ?? activeLayerId;
    }
    return { ...state, layers, activeLayerId };
  },
};

export function createRemoveVariantOp(stackId: string, variantId: string, region?: BBox): Operation {
  return {
    id: genId('removeVariant'),
    type: 'removeVariant',
    klass: 'edit',
    params: { stackId, variantId },
    region: region ?? EMPTY,
    layerId: variantId,
    timestamp: Date.now(),
  };
}
