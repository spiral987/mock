import type { BlendMode, EditorState, ImageBuffer, Layer, LayerNode } from '../types';
import { createImageBuffer } from './imageBuffer';
import { isGroup, isVariantStack, resolveSlot } from './layer';

export interface FlattenOptions {
  /** 背景色 RGBA(0..255)。既定は不透明白（エディタ表示と一致）。 */
  background?: [number, number, number, number];
}

/**
 * EditorState を1枚の RGBA バッファに合成する（純TS, DOM非依存）。
 * 背景の上にレイヤを下から順に source-over 合成する。
 * DOM の canvas を使わないため Node でも動作し、replay のピクセル一致検証や
 * サムネイル生成（Phase 4）に使える。UI 表示もこの結果を putImageData する。
 */
export function flattenState(state: EditorState, opts?: FlattenOptions): ImageBuffer {
  const out = createImageBuffer(state.width, state.height);
  const [br, bg, bb, ba] = opts?.background ?? [255, 255, 255, 255];
  // 背景塗り: 全画素を1つずつ回すと 4K(≈1670万画素) で無視できないコストになる。RGBA を 1 つの
  // 32bit 値にパックし、Uint32 ビューへ .fill する（同じバイト列を書くので replay とビット一致）。
  // 透明(全0)背景は Uint8ClampedArray が 0 初期化済みなので塗り自体を省く。
  if (br !== 0 || bg !== 0 || bb !== 0 || ba !== 0) {
    fillRGBA(out.data, br, bg, bb, ba);
  }
  compositeNodes(out, state.layers, state.width, state.height);
  return out;
}

/** RGBA バッファを単色で高速に塗る（エンディアン非依存: バイト列で pack してから 32bit で fill）。 */
function fillRGBA(data: Uint8ClampedArray, r: number, g: number, b: number, a: number): void {
  const packBuf = new ArrayBuffer(4);
  const packU8 = new Uint8Array(packBuf);
  packU8[0] = r;
  packU8[1] = g;
  packU8[2] = b;
  packU8[3] = a;
  const packed = new Uint32Array(packBuf)[0];
  new Uint32Array(data.buffer, data.byteOffset, data.length >> 2).fill(packed);
}

/**
 * レイヤーツリーを下から順に out に合成する（再帰）。
 * フォルダ(group)は子を独立した透明バッファに合成してから、group 全体の opacity で out に重ねる
 * （フォルダの不透明度/表示がまとめて効く＝isolation）。
 *
 * クリッピング: clipped=true のリーフは、直下にある「非クリップのノード（下地）」のアルファで
 * マスクして重ねる。下地の直上に連続する clipped 群は同じ下地にクリップする（Photoshop 準拠）。
 * 下地はリーフでもフォルダでもよい（フォルダの場合は合成後アルファをマスクに使う）。
 */
function compositeNodes(out: ImageBuffer, rawNodes: LayerNode[], width: number, height: number): void {
  const nodes = resolveVariants(rawNodes);
  let i = 0;
  while (i < nodes.length) {
    const base = nodes[i];
    // 下地の直上に連続する clipped リーフ（＝この下地にクリップする群）を集める。
    let j = i + 1;
    while (j < nodes.length && !isGroup(nodes[j]) && (nodes[j] as Layer).clipped) j++;
    const clips = nodes.slice(i + 1, j) as Layer[];
    i = j;

    if (clips.length === 0) {
      // 通常合成（クリップ無し）。
      if (!base.visible || base.opacity <= 0) continue;
      renderNode(out, base, width, height);
      continue;
    }

    // 下地が非表示ならクリップ群ごと出さない（PS 挙動）。
    if (!base.visible || base.opacity <= 0) continue;
    // 下地を透明バッファへ合成し、そのアルファをクリップのマスクに使う。
    // 透明バッファへの合成ではブレンドモードは効かない（下に何も無い＝normal と同じ）ので、
    // 下地・クリップそれぞれの合成方法は「出力へ重ねるとき」に一度だけ適用する。
    const baseBuf = createImageBuffer(width, height);
    renderNode(baseBuf, base, width, height);
    compositeLayer(out, fullCanvasLayer(baseBuf, base.blendMode)); // 下地を出力へ
    for (const clip of clips) {
      if (!clip.visible || clip.opacity <= 0) continue;
      const tmp = createImageBuffer(width, height);
      compositeLayer(tmp, clip); // クリップ内容（不透明度込み）を透明バッファへ
      maskAlphaBy(tmp, baseBuf); // 下地アルファでマスク
      compositeLayer(out, fullCanvasLayer(tmp, clip.blendMode));
    }
  }
}

/**
 * 差分スタック（横軸）を解決し、「いまそこに在るノード」だけの列にする。
 * スタックを active な差分そのものへ置き換えるので、クリッピングの下地判定も z 順も
 * 「その差分が直接その位置に居る」場合と完全に同じ規則で働く（横軸は合成規則を増やさない）。
 * スロットごと非表示（stack.visible=false）なら列から落ちる。
 */
function resolveVariants(nodes: LayerNode[]): LayerNode[] {
  if (!nodes.some(isVariantStack)) return nodes; // 横軸なしが通常。配列を作り直さない。
  const out: LayerNode[] = [];
  for (const n of nodes) {
    const slot = resolveSlot(n);
    if (slot) out.push(slot);
  }
  return out;
}

/** 1ノード（リーフ or フォルダ）を out に合成する。フォルダは子を独立バッファへ合成してから重ねる。 */
function renderNode(out: ImageBuffer, node: LayerNode, width: number, height: number): void {
  if (isGroup(node)) {
    const groupBuf = createImageBuffer(width, height);
    compositeNodes(groupBuf, node.children, width, height);
    compositeLayer(out, {
      id: node.id,
      name: node.name,
      buffer: groupBuf,
      offsetX: 0,
      offsetY: 0,
      visible: true,
      opacity: node.opacity,
      blendMode: node.blendMode, // フォルダの合成結果まるごとを、この方法で下地へ重ねる
    });
  } else {
    compositeLayer(out, node);
  }
}

/** フルキャンバス（offset0・不透明度1）の擬似リーフ。合成済みバッファを out へそのまま重ねる用。 */
function fullCanvasLayer(buffer: ImageBuffer, blendMode?: BlendMode): Layer {
  return { id: '', name: '', buffer, offsetX: 0, offsetY: 0, visible: true, opacity: 1, blendMode };
}

/** target のアルファに mask のアルファ（0..1）を掛ける（同一寸法のフルキャンバス前提）。 */
function maskAlphaBy(target: ImageBuffer, mask: ImageBuffer): void {
  const td = target.data;
  const md = mask.data;
  for (let k = 3; k < td.length; k += 4) {
    if (td[k] === 0) continue;
    td[k] = Math.round((td[k] * md[k]) / 255);
  }
}

// ============================================================================
// 部分合成（表示の部分再描画）
// ============================================================================

/** リーフの offset を dx,dy ずらした木を返す（矩形原点へ平行移動。イミュータブル）。 */
function shiftLeaves(nodes: LayerNode[], dx: number, dy: number): LayerNode[] {
  return nodes.map((n) =>
    isGroup(n)
      ? { ...n, children: shiftLeaves(n.children, dx, dy) }
      : { ...n, offsetX: n.offsetX + dx, offsetY: n.offsetY + dy },
  );
}

/**
 * アートボードの矩形領域 [rx,rx+rw]×[ry,ry+rh] だけを合成する（表示の部分再描画用）。
 * 全リーフを (rx,ry) 原点へ平行移動した rw×rh の state を作って flattenState を再利用するので、
 * 返るバッファは「フル合成をこの矩形で切り出したもの」とビット一致する（背景は flattenState と同じ既定色）。
 * コストがキャンバス全体ではなく矩形面積に比例するため、4K 以上でも編集の確定/undo が軽くなる。
 */
export function flattenStateRegion(
  state: EditorState,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  opts?: FlattenOptions,
): ImageBuffer {
  const shifted: EditorState = {
    width: rw,
    height: rh,
    activeLayerId: state.activeLayerId,
    layers: shiftLeaves(state.layers, -rx, -ry),
  };
  return flattenState(shifted, opts);
}

/**
 * 1レイヤを offset 位置・opacity 込みで out に合成する（既定は source-over）。
 *
 * blendMode='multiply' のときは W3C Compositing の分離可能ブレンドと同じ式で掛け算する:
 *   Co = αs·(1-αb)·Cs + αs·αb·B(Cb,Cs) + (1-αs)·αb·Cb   （B(Cb,Cs) = Cb·Cs）
 * これは「ソース色 Cs を Cs' = (1-αb)·Cs + αb·Cb·Cs で置き換えた source-over」と恒等なので、
 * 下の source-over の式に Cs' を入れるだけで済む（＝normal 経路の演算は一切変えない＝既存ログとビット一致）。
 * αb=0（下が透明）なら Cs'=Cs で normal に一致し、αb=1 なら Cs'=Cb·Cs で素の乗算になる。
 */
export function compositeLayer(out: ImageBuffer, layer: Layer): void {
  const { buffer, opacity } = layer;
  const multiply = layer.blendMode === 'multiply';
  // オフセットは設計上整数だが、非整数だと宛先インデックスが非整数になり代入が
  // サイレントに無視され、レイヤが消える。防御的に丸めて整数化する。
  const offsetX = Math.round(layer.offsetX);
  const offsetY = Math.round(layer.offsetY);
  if (opacity <= 0) return; // 完全透明レイヤは何も書かない（全画素 sa=0 と同値。ループ丸ごと省略）。
  const ow = out.width;
  const oh = out.height;
  const bw = buffer.width;
  const bh = buffer.height;
  const od = out.data;
  const sd = buffer.data;
  // レイヤ不透明度 1（＝素材そのまま）は最頻ケース。ソース画素が完全不透明なら結果は背景に依らず
  // (r,g,b,255) と一致するため、除算・ブレンドを丸ごと省いて直接コピーできる（blendPixel の a>=1
  // 高速パスと同じ理屈でビット一致）。この分岐で不透明レイヤの全画素ブレンドを回避する。
  // 乗算では結果が背景色に依存するのでこの近道は使えない（不透明でも掛け算が要る）。
  const fullyOpaque = opacity === 1 && !multiply;
  // 交差する行/列だけを回す（範囲外の continue を大量に踏まない）。
  const y0 = Math.max(0, -offsetY);
  const y1 = Math.min(bh, oh - offsetY);
  const x0 = Math.max(0, -offsetX);
  const x1 = Math.min(bw, ow - offsetX);
  for (let y = y0; y < y1; y++) {
    const oy = y + offsetY;
    let si = (y * bw + x0) * 4;
    let oi = (oy * ow + (x0 + offsetX)) * 4;
    for (let x = x0; x < x1; x++, si += 4, oi += 4) {
      const srcA = sd[si + 3];
      if (srcA === 0) continue;
      if (fullyOpaque && srcA === 255) {
        // 完全不透明ソース: 背景に依らず素材色で置き換わる（従来経路とビット同一）。
        od[oi] = sd[si];
        od[oi + 1] = sd[si + 1];
        od[oi + 2] = sd[si + 2];
        od[oi + 3] = 255;
        continue;
      }
      const sa = (srcA / 255) * opacity;
      if (sa <= 0) continue;
      const dstA = od[oi + 3];
      if (dstA === 0) {
        // 背景が完全透明: 結果色 = 素材色そのまま（(sr*sa)/sa = sr）。アルファのみ sa を反映。
        // 乗算でも αb=0 では Cs'=Cs なので、この近道は両モードで正しい。
        od[oi] = sd[si];
        od[oi + 1] = sd[si + 1];
        od[oi + 2] = sd[si + 2];
        od[oi + 3] = Math.round(sa * 255);
        continue;
      }
      const da = dstA / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) {
        od[oi] = 0;
        od[oi + 1] = 0;
        od[oi + 2] = 0;
        od[oi + 3] = 0;
        continue;
      }
      let sr = sd[si] / 255;
      let sg = sd[si + 1] / 255;
      let sb = sd[si + 2] / 255;
      const dr = od[oi] / 255;
      const dg = od[oi + 1] / 255;
      const db = od[oi + 2] / 255;
      if (multiply) {
        // Cs' = (1-αb)·Cs + αb·(Cb·Cs) = Cs·(1 - αb·(1 - Cb))
        sr *= 1 - da * (1 - dr);
        sg *= 1 - da * (1 - dg);
        sb *= 1 - da * (1 - db);
      }
      od[oi] = Math.round(((sr * sa + dr * da * (1 - sa)) / outA) * 255);
      od[oi + 1] = Math.round(((sg * sa + dg * da * (1 - sa)) / outA) * 255);
      od[oi + 2] = Math.round(((sb * sa + db * da * (1 - sa)) / outA) * 255);
      od[oi + 3] = Math.round(outA * 255);
    }
  }
}
