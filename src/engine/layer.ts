import type { BBox, Layer, LayerGroup, LayerNode } from '../types';
import { createImageBuffer, cloneImageBuffer } from './imageBuffer';

export function createLayer(id: string, name: string, width: number, height: number): Layer {
  return {
    id,
    name,
    buffer: createImageBuffer(width, height),
    offsetX: 0,
    offsetY: 0,
    visible: true,
    opacity: 1,
  };
}

/** ノードがフォルダ(LayerGroup)か（リーフ Layer との型ガード）。 */
export function isGroup(node: LayerNode): node is LayerGroup {
  return 'children' in node;
}

export function createGroup(id: string, name: string): LayerGroup {
  return { id, name, visible: true, opacity: 1, children: [] };
}

// ---- 差分スタック（レイヤーの横軸） ---------------------------------------
// 「1つのスロットに、互いに排他な差分を左右に並べる」ためのグループ。children[variantIndex]
// だけが実体としてそこに在り、他は存在しない。縦軸(z順)の道具をそのまま流用できるよう
// LayerGroup の一種として表現しているので、移動/削除/リネーム/D&D は既存経路で動く。

/** ノードが差分スタック（横軸を持つスロット）か。 */
export function isVariantStack(node: LayerNode): node is LayerGroup {
  return isGroup(node) && node.variantIndex !== undefined;
}

/** variantIndex を children の範囲へクランプした実効インデックス（空なら -1）。 */
export function variantIndexOf(stack: LayerGroup): number {
  if (stack.children.length === 0) return -1;
  const i = Math.trunc(stack.variantIndex ?? 0);
  return Math.max(0, Math.min(stack.children.length - 1, i));
}

/** いま「そこに在る」差分（＝合成・UI 表示の実体）。空スタックなら undefined。 */
export function activeVariant(stack: LayerGroup): LayerNode | undefined {
  const i = variantIndexOf(stack);
  return i < 0 ? undefined : stack.children[i];
}

/**
 * スロットを解決して、そこに実際に在るノードを返す（差分スタックの入れ子も辿る）。
 * スタックごと非表示なら null（スロットに何も無い）。スタックでなければそのまま返す。
 */
export function resolveSlot(node: LayerNode): LayerNode | null {
  let cur: LayerNode | undefined = node;
  while (cur && isVariantStack(cur)) {
    if (!cur.visible || cur.opacity <= 0) return null;
    cur = activeVariant(cur);
  }
  return cur ?? null;
}

/**
 * 差分スタックを作る（スロットの容れ物なので visible/opacity は固定）。
 * 既定では畳んで表示される＝「1 スロット 1 行」で、いま出ている差分だけが見える
 * （畳んでいるかどうかは UI 側のローカルな状態。types.ts の LayerGroup のコメント参照）。
 */
export function createVariantStack(id: string, children: LayerNode[], index: number): LayerGroup {
  return {
    id,
    name: 'Variants',
    visible: true,
    opacity: 1,
    children,
    variantIndex: Math.max(0, Math.min(Math.max(0, children.length - 1), index)),
  };
}

/**
 * 空スロット（「何も無い」を選べる中身にしたもの）。中身の無いフォルダなので合成は何も出さない。
 *
 * これがあると、行を消す手段が 2 つある状態を解消できる:
 *   - 一時的に行ごと消す   → スロット（行）の visible。全状態に効く、その場かぎりの操作
 *   - この状態では出さない → 空スロットに所属させる。維持される関係（規則4 の実体）
 * 差分の中身に付いた表示/非表示は、どちらの意味でもないので持たせない。
 */
export function createEmptySlot(id: string): LayerGroup {
  return { id, name: '（空）', visible: true, opacity: 1, children: [], empty: true };
}

/** 空スロットか（＝「何も無い」を表す中身）。 */
export function isEmptySlot(node: LayerNode): boolean {
  return isGroup(node) && node.empty === true;
}

/** ノード以下の全リーフ(Layer)の id を集める。 */
export function collectLeafIds(node: LayerNode): string[] {
  if (!isGroup(node)) return [node.id];
  return node.children.flatMap(collectLeafIds);
}

/** ノード自身と全子孫の id を集める（グループ含む。サイクル検出に使う）。 */
export function collectNodeIds(node: LayerNode): string[] {
  if (!isGroup(node)) return [node.id];
  return [node.id, ...node.children.flatMap(collectNodeIds)];
}

/**
 * そのノードで「いま実際に絵に出ている」最初のリーフ id（差分スタックは出ている差分だけ辿る）。
 * 差分を入れ替えたときに描き先を見失わせないための付け替え先。
 */
export function shownLeafId(node: LayerNode): string | undefined {
  if (isVariantStack(node)) {
    const v = activeVariant(node);
    return v ? shownLeafId(v) : undefined;
  }
  if (isGroup(node)) {
    for (const c of node.children) {
      const r = shownLeafId(c);
      if (r) return r;
    }
    return undefined;
  }
  return node.id;
}

/** ノード配列内の最初のリーフ id（active 付け替えのフォールバック用）。 */
export function firstLeafId(nodes: LayerNode[]): string | undefined {
  for (const n of nodes) {
    const ids = collectLeafIds(n);
    if (ids.length) return ids[0];
  }
  return undefined;
}

/**
 * レイヤを複製する。既定ではバッファも複製する（ピクセルを書き換える操作向け）。
 * バッファを変更しない操作（translate 等）では cloneBuffer:false で共有してよい
 * （バッファは「書く前に必ず複製」という規約のもとで不変として扱う）。
 */
export function cloneLayer(layer: Layer, opts?: { cloneBuffer?: boolean }): Layer {
  return {
    ...layer,
    buffer: opts?.cloneBuffer === false ? layer.buffer : cloneImageBuffer(layer.buffer),
  };
}

/**
 * レイヤの内容（不透明ピクセル）の bounding box をキャンバス座標で返す。
 * 内容が無ければ空 bbox {0,0,0,0}。color/translate 操作の「影響範囲」(region) 算出に使う
 * （原論文の領域ベース依存判定を全面近似なしで成立させるため）。
 */
export function layerContentBBox(layer: Layer): BBox {
  const { buffer, offsetX, offsetY } = layer;
  const { width: w, height: h, data } = buffer;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX + offsetX, y: minY + offsetY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
