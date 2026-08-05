import type { EditorState, Operation, StrokePoint } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { cloneLayer } from '../layer';
import { rasterizeStroke } from '../strokeRaster';
import {
  brushSettings,
  createEraseStamp,
  resolveProfile,
  sameSettings,
  PAPER_SEED,
  type BrushSettings,
  type BrushType,
} from '../brushProfile';
import { maskStamp } from '../selection';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../geom';
import { genId } from '../../util/id';

export interface EraserParams {
  size: number; // 直径(px)
  opacity: number; // 0..1（消去の強さ）
  /**
   * 消し口の質感（省略時 'pen' = 従来の硬い円の消しゴム）。
   * 「透明色」で筆を使うと、その筆の brushType/brush がここへ焼き込まれ、
   * 筆の性格（間隔・筆圧カーブ・ぼかし・紙目）をそのままに色ではなくアルファを削る。
   * 省略可なので、これを持たない既存ログもそのまま同じ結果に replay できる。
   */
  brushType?: BrushType;
  brush?: BrushSettings;
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const pa = a as unknown as EraserParams;
  const pb = b as unknown as EraserParams;
  return (
    pa.size === pb.size &&
    pa.opacity === pb.opacity &&
    (pa.brushType ?? 'pen') === (pb.brushType ?? 'pen') &&
    // 質感を途中で変えたら別の消しゴムとして扱う（統合すると先の分まで新しい質感になる）。
    sameSettings(brushSettings(pa.brushType, pa.brush), brushSettings(pb.brushType, pb.brush))
  );
}

export const eraserHandler: OpHandler = {
  type: 'eraser',
  klass: 'brush',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const params = op.params as unknown as EraserParams;
    const newLayer = cloneLayer(layer);
    const settings = brushSettings(params.brushType, params.brush);
    rasterizeStroke(
      newLayer.buffer,
      op.strokes ?? [],
      params.size / 2,
      layer.offsetX,
      layer.offsetY,
      // 選択範囲があるときはその内側だけ消す（無ければ元の関数がそのまま使われる）。
      maskStamp(
        createEraseStamp(params.opacity, settings, op.seed ?? PAPER_SEED),
        state.selection,
        layer.offsetX,
        layer.offsetY,
      ),
      resolveProfile(settings),
    );
    return replaceLayer(state, newLayer);
  },

  consolidate(prev: Operation, next: Operation): Operation | null {
    if (prev.layerId !== next.layerId) return null;
    if (!sameParams(prev.params, next.params)) return null;
    // 紙目の seed が違うと統合後に next 側も prev の seed で消され、逐次適用と一致しなくなる。
    if ((prev.seed ?? PAPER_SEED) !== (next.seed ?? PAPER_SEED)) return null;
    return {
      ...prev,
      strokes: [...(prev.strokes ?? []), ...(next.strokes ?? [])],
      region: unionBBox(prev.region, next.region),
      timestamp: next.timestamp,
    };
  },
};

export function createEraserOp(
  layerId: string,
  strokes: StrokePoint[],
  params: EraserParams,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('eraser'),
    type: 'eraser',
    klass: 'brush',
    params: {
      size: params.size,
      opacity: params.opacity,
      ...(params.brushType && params.brushType !== 'pen' ? { brushType: params.brushType } : {}),
      // 既定のプリセットどおりなら焼き込まない（省略時は同じ既定に解決される）。
      ...(params.brush && !sameSettings(params.brush, brushSettings(params.brushType))
        ? { brush: { ...params.brush } }
        : {}),
    },
    region: clampBBox(padBBox(strokesBBox(strokes), params.size / 2 + 1), width, height),
    layerId,
    seed: PAPER_SEED, // 紙目は「紙の性質」なので固定（ブラシと同じ目の上を消せる）
    // 先頭点をサブストローク開始としてマーク（統合時に前操作との連結線を防ぐ）。
    strokes: strokes.map((p, i) => (i === 0 ? { ...p, down: true } : { ...p })),
    timestamp: Date.now(),
  };
}
