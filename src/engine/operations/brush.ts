import type { EditorState, Operation, StrokePoint } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { blendPixel, growBufferToInclude } from '../imageBuffer';
import { rasterizeStroke } from '../strokeRaster';
import {
  brushSettings,
  resolveProfile,
  createBrushStamp,
  sameSettings,
  PAPER_SEED,
  type BrushSettings,
  type BrushType,
} from '../brushProfile';
import { maskStamp } from '../selection';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../geom';
import { genId } from '../../util/id';

export interface BrushParams {
  color: [number, number, number]; // 0..255
  size: number; // 直径(px)
  opacity: number; // 0..1
  /**
   * 筆の質感（省略時 'pen' = 従来の挙動）。省略可にしてあるので、これを持たない既存ログも
   * そのまま同じ絵に replay できる。筆を変えると sameParams が不一致になり consolidate も切れる。
   */
  brushType?: BrushType;
  /**
   * 筆の質感パラメータ。UI で調整した値をここへ焼き込むことで、後から設定を変えても
   * 過去の op は当時の質感のまま replay される（state === replay(log) を保つ要）。
   * 省略時は brushType のプリセット（＝これを持たない既存ログもそのまま再現できる）。
   */
  brush?: BrushSettings;
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const pa = a as unknown as BrushParams;
  const pb = b as unknown as BrushParams;
  return (
    pa.size === pb.size &&
    pa.opacity === pb.opacity &&
    (pa.brushType ?? 'pen') === (pb.brushType ?? 'pen') &&
    // 質感を途中で変えたら別の筆として扱う（統合すると先の分まで新しい質感で描かれてしまう）。
    sameSettings(brushSettings(pa.brushType, pa.brush), brushSettings(pb.brushType, pb.brush)) &&
    pa.color[0] === pb.color[0] &&
    pa.color[1] === pb.color[1] &&
    pa.color[2] === pb.color[2]
  );
}

export const brushHandler: OpHandler = {
  type: 'brush',
  klass: 'brush',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const strokes = op.strokes ?? [];
    if (strokes.length === 0) return state;
    const params = op.params as unknown as BrushParams;
    const radius = params.size / 2;

    // ストロークのレイヤローカル領域（= キャンバス座標 − 現オフセット）を内包するよう
    // バッファを拡張する。これにより非破壊移動(offset)後もキャンバス全面に描ける。
    const sb = strokesBBox(strokes);
    const pad = Math.ceil(radius) + 2;
    const grown = growBufferToInclude(
      layer.buffer,
      layer.offsetX,
      layer.offsetY,
      sb.x - layer.offsetX - pad,
      sb.y - layer.offsetY - pad,
      sb.x + sb.w - layer.offsetX + pad,
      sb.y + sb.h - layer.offsetY + pad,
    );

    const settings = brushSettings(params.brushType, params.brush);
    rasterizeStroke(
      grown.buffer,
      strokes,
      radius,
      grown.offsetX,
      grown.offsetY,
      // 選択範囲があるときは書き込みをその被覆率で抑える（外側には一切乗らない）。
      // 選択が無ければ maskStamp は元の StampFn をそのまま返すので従来とビット同一。
      maskStamp(
        createBrushStamp(params.color, params.opacity, settings, op.seed ?? PAPER_SEED),
        state.selection,
        grown.offsetX,
        grown.offsetY,
      ),
      resolveProfile(settings),
    );
    return replaceLayer(state, {
      ...layer,
      buffer: grown.buffer,
      offsetX: grown.offsetX,
      offsetY: grown.offsetY,
    });
  },

  // 同一パラメータの連続ブラシは点列を連結して1操作に統合（SPEC 受け入れ条件）。
  // バッファ拡張を伴っても「逐次適用 == 統合1回適用」は厳密に成立する
  // （最終バッファ範囲 = 全ストローク領域の bounding box で結合的、合成順序も保存されるため）。
  consolidate(prev: Operation, next: Operation): Operation | null {
    if (prev.layerId !== next.layerId) return null;
    if (!sameParams(prev.params, next.params)) return null;
    // 紙目の seed が違うと、統合後は next 側の点も prev の seed で描かれてしまい
    // 「逐次適用 == 統合1回適用」が崩れる。実際は PAPER_SEED 固定なので常に一致する。
    if ((prev.seed ?? PAPER_SEED) !== (next.seed ?? PAPER_SEED)) return null;
    return {
      ...prev,
      strokes: [...(prev.strokes ?? []), ...(next.strokes ?? [])],
      region: unionBBox(prev.region, next.region),
      timestamp: next.timestamp,
    };
  },
};

export function createBrushOp(
  layerId: string,
  strokes: StrokePoint[],
  params: BrushParams,
  width: number,
  height: number,
): Operation {
  return {
    id: genId('brush'),
    type: 'brush',
    klass: 'brush',
    params: {
      color: [...params.color],
      size: params.size,
      opacity: params.opacity,
      ...(params.brushType && params.brushType !== 'pen' ? { brushType: params.brushType } : {}),
      // 既定のプリセットどおりなら焼き込まない（ログを素直に保つ。省略時は同じ既定に解決される）。
      ...(params.brush && !sameSettings(params.brush, brushSettings(params.brushType))
        ? { brush: { ...params.brush } }
        : {}),
    },
    // どのプロファイルも radiusAt は baseRadius を超えないので、この pad のままで足りる。
    region: clampBBox(padBBox(strokesBBox(strokes), params.size / 2 + 1), width, height),
    layerId,
    seed: PAPER_SEED, // 紙目は「紙の性質」なので固定（重ね塗りで目が揃う／consolidate も通る）

    // 先頭点をサブストローク開始としてマーク（統合時に前操作との連結線を防ぐ）。
    strokes: strokes.map((p, i) => (i === 0 ? { ...p, down: true } : { ...p })),
    timestamp: Date.now(),
  };
}
