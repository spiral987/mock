import type { EditorState, ImageBuffer } from '../types';
import { flattenState, flattenStateRegion } from '../engine/composite';

/**
 * EditorState を純TSの flattenState で1枚に合成し、キャンバスへ putImageData する。
 * 表示ピクセルが replay/サムネイルの flatten 結果と完全一致するよう、合成は1経路に統一する。
 */
export function compositeToCanvas(canvas: HTMLCanvasElement, state: EditorState): void {
  if (canvas.width !== state.width) canvas.width = state.width;
  if (canvas.height !== state.height) canvas.height = state.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const flat = flattenState(state);
  const img = ctx.createImageData(flat.width, flat.height);
  img.data.set(flat.data);
  ctx.putImageData(img, 0, 0);
}

/**
 * キャンバスの矩形領域だけを合成し直して putImageData する（部分再描画）。canvas のサイズは変えない。
 * 全面 flatten と違い、コストが矩形面積に比例するので、編集の確定・undo/redo・不透明度変更が軽くなる。
 * region はキャンバス内にクランプ済みであることを前提とする（呼び出し側 repaintRegion が保証）。
 */
export function compositeRegionToCanvas(
  canvas: HTMLCanvasElement,
  state: EditorState,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const buf = flattenStateRegion(state, rx, ry, rw, rh);
  const img = ctx.createImageData(rw, rh);
  img.data.set(buf.data);
  ctx.putImageData(img, rx, ry);
}

/** 合成済み ImageBuffer をそのままキャンバスへ描く（並行編集の A/B 比較 peek 表示用）。 */
export function drawBufferToCanvas(canvas: HTMLCanvasElement, buf: ImageBuffer): void {
  if (canvas.width !== buf.width) canvas.width = buf.width;
  if (canvas.height !== buf.height) canvas.height = buf.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(buf.width, buf.height);
  img.data.set(buf.data);
  ctx.putImageData(img, 0, 0);
}
