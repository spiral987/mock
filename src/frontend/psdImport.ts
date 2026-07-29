// PSD インポート。
// ag-psd で PSD を解析し、レイヤーツリー（フォルダ含む）を当エンジンの操作列へ変換する。
// PSD の実寸をそのままキャンバスサイズにして新規ドキュメントとして開く（ブラウザ上限 maxDim を
// 超える場合のみ全体を等比縮小して収める）。画素は addImageLayer 操作に base64 で焼き込まれるので、
// log だけから決定的に replay できる（不変条件 state === replay(log) を維持）。呼び出し側は新しい
// サイズでセッションを作り直し、session.applyBatch(ops) で 1回の Undo 単位として取り込む。
//
// 対応: レイヤー名 / 位置(offset) / 不透明度 / 表示・非表示 / フォルダ階層 / 折りたたみ状態 /
//   クリッピング（エンジンのライブなクリッピングとして復元。ピクセルは焼き込まない）。
// 非対応(MVP): ブレンドモード（すべて normal 合成）/ レイヤーマスク / グループのクリッピング /
//   調整レイヤー・テキストのベクター情報（ラスタライズ済み画素のみ取り込む）。
//
// レイヤー順序について:
//   ag-psd の children は index0 が最背面（一番下）、末尾が最前面（一番上）。
//   当エンジンも layers[0] が最背面で、末尾に追加＝最前面。したがって children を
//   前方（0→末尾＝下→上）に処理し、各ノードをフォルダ末尾へ足せば重なり順が一致する。
import { readPsd, type Layer as PsdLayer } from 'ag-psd';
import type { ImageBuffer, Operation } from '../types';
import { genId } from '../util/id';
import { BASE_LAYER_ID } from '../engine/editorState';
import {
  createAddImageLayerOp,
  createAddGroupOp,
  createMoveNodeOp,
  createRemoveLayerOp,
  createSetLayerOpacityOp,
  createSetLayerVisibilityOp,
  createSetLayerClippingOp,
  createSetGroupCollapsedOp,
} from '../engine/operations';

export interface PsdImportResult {
  /** 作成すべきキャンバスサイズ（PSD 実寸を maxDim にクランプ）。 */
  width: number;
  height: number;
  /** applyBatch に渡す操作列（空なら取り込めるレイヤーが無かった）。 */
  ops: Operation[];
  /** 取り込んだリーフ（画像）レイヤー数。 */
  leafCount: number;
  /** 取り込んだフォルダ数。 */
  groupCount: number;
  /** クリッピング指定で取り込んだレイヤー数。 */
  clipCount: number;
  /** 上限超過で縮小したか（PSD が maxDim より大きいとき true）。 */
  scaled: boolean;
  /** PSD 本来のサイズ。 */
  psdWidth: number;
  psdHeight: number;
}

/** ag-psd の opacity は 0..1。念のため 0..255 で来た場合も正規化する。 */
function normOpacity(o: number | undefined): number {
  if (o === undefined) return 1;
  return o > 1 ? o / 255 : o;
}

/**
 * PSD レイヤーの画素を ImageBuffer(RGBA 8bit straight) へ変換する。
 * ag-psd 既定の canvas を使うことで 8/16/32bit や CMYK でもライブラリが 8bit RGBA へ正規化する。
 * scale<1 のときは高品質縮小。内容が無い（canvas なし/サイズ0）なら null。
 */
function rasterizeLeaf(node: PsdLayer, scale: number): ImageBuffer | null {
  const src = node.canvas;
  if (!src || src.width <= 0 || src.height <= 0) return null;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  if (scale !== 1) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: img.data };
}

/**
 * PSD(ArrayBuffer) を解析し、「PSD 実寸のキャンバス＋そこへ取り込む操作列」を生成する。
 * PSD が maxDim（1辺の上限）を超える場合のみ全体を等比縮小して収める。
 */
export function buildPsdImportOps(buffer: ArrayBuffer, maxDim = 16384): PsdImportResult {
  const psd = readPsd(buffer, { skipThumbnail: true, skipCompositeImageData: true });
  const psdWidth = psd.width || 1;
  const psdHeight = psd.height || 1;
  // 実寸で開く。上限を超える辺があるときだけ等比縮小してキャンバスに収める。
  const scale = Math.min(1, maxDim / psdWidth, maxDim / psdHeight);
  const canvasW = Math.max(1, Math.round(psdWidth * scale));
  const canvasH = Math.max(1, Math.round(psdHeight * scale));

  const ops: Operation[] = [];
  let leafCount = 0;
  let groupCount = 0;
  let clipCount = 0;

  // 兄弟配列を下→上（前方）に処理する。addImageLayer / addGroup は最上位末尾（＝最前面）に
  // 追加されるので、parentId があるときだけ moveNode でそのフォルダの末尾へ入れ直す。
  const addSiblings = (siblings: PsdLayer[], parentId: string | null): void => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];

      if (node.children) {
        // ---- フォルダ（グループ） ----
        const groupId = genId('group');
        ops.push(createAddGroupOp(groupId, node.name || 'Folder'));
        if (parentId !== null) ops.push(createMoveNodeOp(groupId, parentId, Number.MAX_SAFE_INTEGER));
        const op = normOpacity(node.opacity);
        if (op < 1) ops.push(createSetLayerOpacityOp(groupId, op));
        if (node.hidden) ops.push(createSetLayerVisibilityOp(groupId, false));
        if (node.opened === false) ops.push(createSetGroupCollapsedOp(groupId, true));
        groupCount++;
        addSiblings(node.children, groupId);
        continue;
      }

      // ---- リーフ（画像レイヤー） ----
      const buf = rasterizeLeaf(node, scale);
      if (!buf) continue; // 画素の無いレイヤー（調整/テキスト/空）はスキップ
      const layerId = genId('layer');
      const name = node.name || `Layer ${leafCount + 1}`;
      const offsetX = Math.round((node.left ?? 0) * scale);
      const offsetY = Math.round((node.top ?? 0) * scale);
      ops.push(createAddImageLayerOp(layerId, name, buf, offsetX, offsetY, canvasW, canvasH));
      if (parentId !== null) ops.push(createMoveNodeOp(layerId, parentId, Number.MAX_SAFE_INTEGER));
      const op = normOpacity(node.opacity);
      if (op < 1) ops.push(createSetLayerOpacityOp(layerId, op));
      if (node.hidden) ops.push(createSetLayerVisibilityOp(layerId, false));
      // クリッピング: エンジンのライブなクリッピングとして復元（直下の非クリップ下地にクリップ）。
      if (node.clipping) {
        ops.push(createSetLayerClippingOp(layerId, true));
        clipCount++;
      }
      leafCount++;
    }
  };

  addSiblings(psd.children ?? [], null);

  // 新規セッションの初期空レイヤー（Background）を除去し、PSD そのものの構成にする。
  // リーフを取り込めた場合のみ（除去で最低1リーフを割らないよう removeLayer 側が安全に判定）。
  if (leafCount > 0) ops.push(createRemoveLayerOp(BASE_LAYER_ID));

  return {
    width: canvasW,
    height: canvasH,
    ops,
    leafCount,
    groupCount,
    clipCount,
    scaled: scale < 1,
    psdWidth,
    psdHeight,
  };
}
