import type {
  Attachment,
  BlendMode,
  EditorState,
  Layer,
  LayerGroup,
  LayerNode,
  Operation,
  VariantState,
} from '../../types';
import type { OpHandler } from '../operation';
import { base64ToBuffer, bufferToBase64 } from '../imageBuffer';
import { isGroup } from '../layer';
import { fullCanvas } from '../geom';
import { genId } from '../../util/id';

/**
 * 履歴の畳み込み（"baseline" / flatten history）操作（klass=edit）。
 * 現在のレイヤーツリー全体（グループ入れ子・不透明度・表示/非表示・オフセット・名前・画素、および
 * 合成規則である合成方法(blendMode)・クリッピング)を base64(RGBA) として op 内に保持し、
 * apply で state を丸ごと差し替える。
 *
 * これ1つを replay すると元の見た目を完全に再構築できるので、log を本 op 1件に畳んでも
 * 不変条件 state === replay(log) と save/load（log を初期状態から replay）を保てる。
 * 「絵は残し履歴だけ消す」Reset の実体。region は全面で addLayer 同様の全面チェックポイント。
 */

interface SerializedLayer {
  kind: 'layer';
  id: string;
  name: string;
  offsetX: number;
  offsetY: number;
  visible: boolean;
  opacity: number;
  imgWidth: number;
  imgHeight: number;
  data: string; // base64 RGBA, 長さ = imgWidth*imgHeight*4
  /** 合成方法（'normal' は省略）。落とすと乗算が畳み込みで通常合成に戻ってしまう。 */
  blendMode?: BlendMode;
  /** クリッピング（false は省略）。 */
  clipped?: boolean;
}
interface SerializedGroup {
  kind: 'group';
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  children: SerializedNode[];
  /** 差分スタック（横軸）なら、いま出ている差分の位置。落とすと全差分が重なって出てしまう。 */
  variantIndex?: number;
  /** 合成方法（'normal' は省略）。 */
  blendMode?: BlendMode;
  /** 空スロット（「何も無い」を表す中身）。落とすと畳み込みで普通の空フォルダに化ける。 */
  empty?: boolean;
}
type SerializedNode = SerializedLayer | SerializedGroup;

export interface BaselineParams {
  tree: SerializedNode[];
  activeLayerId: string;
  /**
   * 状態と所属。畳み込みは「絵は残して履歴だけ捨てる」操作なので、関係も残さないといけない
   * （落とすと Reset で ver1/ver2 が黙って消える）。所属は木の外にある表なのでそのまま持てる。
   */
  states?: VariantState[];
  attachments?: Attachment[];
}

function serializeNode(n: LayerNode): SerializedNode {
  if (isGroup(n)) {
    return {
      kind: 'group',
      id: n.id,
      name: n.name,
      visible: n.visible,
      opacity: n.opacity,
      children: n.children.map(serializeNode),
      ...(n.variantIndex !== undefined ? { variantIndex: n.variantIndex } : {}),
      ...(n.blendMode && n.blendMode !== 'normal' ? { blendMode: n.blendMode } : {}),
      ...(n.empty ? { empty: true } : {}),
    };
  }
  return {
    kind: 'layer',
    id: n.id,
    name: n.name,
    offsetX: n.offsetX,
    offsetY: n.offsetY,
    visible: n.visible,
    opacity: n.opacity,
    imgWidth: n.buffer.width,
    imgHeight: n.buffer.height,
    data: bufferToBase64(n.buffer),
    ...(n.blendMode && n.blendMode !== 'normal' ? { blendMode: n.blendMode } : {}),
    ...(n.clipped ? { clipped: true } : {}),
  };
}

function deserializeNode(s: SerializedNode): LayerNode {
  if (s.kind === 'group') {
    const g: LayerGroup = {
      id: s.id,
      name: s.name,
      visible: s.visible,
      opacity: s.opacity,
      children: s.children.map(deserializeNode),
      ...(s.variantIndex !== undefined ? { variantIndex: s.variantIndex } : {}),
      ...(s.blendMode ? { blendMode: s.blendMode } : {}),
      ...(s.empty ? { empty: true } : {}),
    };
    return g;
  }
  const layer: Layer = {
    id: s.id,
    name: s.name,
    buffer: base64ToBuffer(s.data, s.imgWidth, s.imgHeight),
    offsetX: s.offsetX,
    offsetY: s.offsetY,
    visible: s.visible,
    opacity: s.opacity,
    ...(s.blendMode ? { blendMode: s.blendMode } : {}),
    ...(s.clipped ? { clipped: true } : {}),
  };
  return layer;
}

export const baselineHandler: OpHandler = {
  type: 'baseline',
  klass: 'edit',

  apply(state: EditorState, op: Operation): EditorState {
    const p = op.params as unknown as BaselineParams;
    return {
      ...state,
      layers: p.tree.map(deserializeNode),
      activeLayerId: p.activeLayerId,
      // 省略（＝状態を作っていない state を畳んだ log）は「状態なし」に戻す。
      states: p.states ? p.states.map((s) => ({ ...s })) : [],
      attachments: p.attachments ? p.attachments.map((a) => ({ ...a })) : [],
    };
  },

  // 畳み込みは統合しない（その場の全状態スナップショット）。
};

/** 現在の state 全体を1つの baseline op にシリアライズする。 */
export function createBaselineOp(state: EditorState, canvasW: number, canvasH: number): Operation {
  const params: BaselineParams = {
    tree: state.layers.map(serializeNode),
    activeLayerId: state.activeLayerId,
    ...(state.states?.length ? { states: state.states.map((s) => ({ ...s })) } : {}),
    ...(state.attachments?.length
      ? { attachments: state.attachments.map((a) => ({ ...a })) }
      : {}),
  };
  return {
    id: genId('baseline'),
    type: 'baseline',
    klass: 'edit',
    params: params as unknown as Record<string, unknown>,
    region: fullCanvas(canvasW, canvasH),
    layerId: state.activeLayerId,
    timestamp: Date.now(),
  };
}
