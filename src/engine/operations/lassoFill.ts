import type { BBox, EditorState, Operation } from '../../types';
import type { OpHandler } from '../operation';
import { getLayer, replaceLayer } from '../editorState';
import { blendPixel, erasePixel, growBufferToInclude } from '../imageBuffer';
import { rasterizePolygon, selectionCoverage } from '../selection';
import { clampBBox } from '../geom';
import { genId } from '../../util/id';

/**
 * 投げ縄塗り（lassoFill, klass=color）。フリーハンドで囲った多角形の内側を塗り色で塗る。
 * 塗りつぶし(fill)が「色の連結領域」を塗るのに対し、こちらは「囲った形」をそのまま塗るので
 * 線が閉じていない下描きでも思った範囲に色を置ける。
 *
 * 領域は selection.rasterizePolygon（nonzero winding + 縦4サブサンプルのAA）で焼くので、
 * 投げ縄選択とまったく同じ形の判定になり、縁もアンチエイリアスされる。純TS・決定的。
 */
export interface LassoFillParams {
  color: [number, number, number]; // 0..255
  opacity: number; // 0..1
  /** 多角形の点列。キャンバス座標の平坦配列 [x0,y0,x1,y1,...]（閉じているものとして扱う）。 */
  path: number[];
  /** true = 「透明色」で塗る＝囲った内側のアルファを削る（＝投げ縄で消す）。 */
  erase?: boolean;
}

export const lassoFillHandler: OpHandler = {
  type: 'lassoFill',
  klass: 'color',

  apply(state: EditorState, op: Operation): EditorState {
    const layer = getLayer(state, op.layerId);
    if (!layer) return state;
    const { color, opacity, path, erase } = op.params as unknown as LassoFillParams;
    const shape = rasterizePolygon(path, state.width, state.height);
    if (!shape) return state;

    // 塗る範囲（キャンバス座標）を内包するようレイヤバッファを広げる。
    // ブラシと同じ経路なので、非破壊移動(offset)後のレイヤーにも正しい位置へ塗れる。
    // （消す場合はバッファ外に消すものは無いが、経路を分けないぶん素直で結果も同じ。）
    const grown = growBufferToInclude(
      layer.buffer,
      layer.offsetX,
      layer.offsetY,
      shape.x - layer.offsetX,
      shape.y - layer.offsetY,
      shape.x + shape.w - layer.offsetX,
      shape.y + shape.h - layer.offsetY,
    );
    const [r, g, b] = color;
    const sel = state.selection;
    for (let py = 0; py < shape.h; py++) {
      const cy = shape.y + py;
      const row = py * shape.w;
      for (let px = 0; px < shape.w; px++) {
        const cov = shape.data[row + px];
        if (cov === 0) continue;
        const cx = shape.x + px;
        // 選択範囲があるときはその内側だけ（被覆率も掛ける）。
        const selCov = selectionCoverage(sel, cx, cy);
        if (selCov <= 0) continue;
        const bx = cx - grown.offsetX;
        const by = cy - grown.offsetY;
        const a = opacity * (cov / 255) * selCov;
        if (erase) erasePixel(grown.buffer, bx, by, a);
        else blendPixel(grown.buffer, bx, by, r, g, b, a);
      }
    }
    return replaceLayer(state, {
      ...layer,
      buffer: grown.buffer,
      offsetX: grown.offsetX,
      offsetY: grown.offsetY,
    });
  },

  // 囲った形はそれぞれ独立なので統合しない（点列を連結すると別の多角形になってしまう）。
};

/** 点列の bbox（キャンバス座標）。 */
function pathBBox(path: readonly number[]): BBox {
  if (path.length < 2) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < path.length; i += 2) {
    const x = path[i];
    const y = path[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function createLassoFillOp(
  layerId: string,
  path: readonly number[],
  params: { color: [number, number, number]; opacity: number; erase?: boolean },
  width: number,
  height: number,
): Operation {
  return {
    id: genId('lassoFill'),
    type: 'lassoFill',
    klass: 'color',
    params: {
      color: [...params.color],
      opacity: params.opacity,
      path: [...path],
      ...(params.erase ? { erase: true } : {}),
    },
    region: clampBBox(pathBBox(path), width, height),
    layerId,
    timestamp: Date.now(),
  };
}
