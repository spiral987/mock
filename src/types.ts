// ============================================================================
// データモデル
// エンジンが必要とする型に絞る。DAG / Revision / Board など研究本体の型は持ち込まない。
// Backend/Engine は React/DOM に一切依存しない純TS。
// ============================================================================

export type OpClass = 'rigid' | 'deform' | 'color' | 'edit' | 'brush';
// rigid:  translation, rotation
// deform: scale, shear, perspective
// color:  hue, saturation, brightness, contrast, gamma, fill, blur, sharpen
// edit:   copy, paste, anchor, addLayer, layerMask, crop
// brush:  brush, pencil, eraser

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
  /**
   * true の点は「ペンダウン＝新しいサブストロークの開始」。直前の点との接続線を引かない。
   * 別々のブラシ操作を1操作に統合(consolidate)しても操作間に偽の連結線が生じないため、
   * 「逐次適用 == 統合1回適用」が厳密に成立する。各操作の先頭点に付与される。
   */
  down?: boolean;
}

export interface Operation {
  id: string;
  type: string; // "brush" | "translate" | "hue" など具体名
  klass: OpClass;
  params: Record<string, unknown>;
  region: BBox; // 影響範囲。MVPでは bbox で近似
  layerId: string;
  /** ブラシ系のみ: 点列と筆圧（決定的再生のために記録） */
  strokes?: StrokePoint[];
  /** 乱数を使う操作は必須（決定性確保） */
  seed?: number;
  timestamp: number;
}

// --- エンジン状態 -----------------------------------------------------------

/** 生のピクセルバッファ。DOM の ImageData に依存せず純TSで扱える形にする。 */
export interface ImageBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, 各値 0..255, 長さ = width*height*4
}

export interface Layer {
  id: string;
  name: string;
  buffer: ImageBuffer;
  /** レイヤ移動(translate)用オフセット。合成時にこの位置へ描画する。 */
  offsetX: number;
  offsetY: number;
  visible: boolean;
  opacity: number; // 0..1
  /**
   * クリッピング（下のレイヤーにクリップ）。true のとき、同じ親内で直下にある「非クリップの
   * ノード（下地）」のアルファでマスクして合成する（Photoshop/クリスタのクリッピングマスク）。
   * 連続する clipped レイヤーは同じ下地にクリップする。省略時は false。非破壊（合成規則）で、
   * 状態から決定的に決まるため replay 一致に影響しない。
   */
  clipped?: boolean;
}

/**
 * レイヤーフォルダ（グループ）。子ノード（レイヤー or さらにグループ）を束ねる。
 * 合成時は children を独立バッファに合成してから group の opacity/visible を適用する。
 * buffer を持たない点で Layer と区別される（型ガード isGroup は 'children' の有無で判定）。
 */
export interface LayerGroup {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
  collapsed: boolean; // UI 表示の折りたたみ（描画には影響しない）
  children: LayerNode[];
}

/** レイヤーツリーのノード = リーフ(Layer) または フォルダ(LayerGroup)。 */
export type LayerNode = Layer | LayerGroup;

/** エディタの完全な状態。replay により log から決定的に再構築できる。 */
export interface EditorState {
  width: number;
  height: number;
  layers: LayerNode[]; // 下から上（layers[0] が最背面）。フォルダで階層化される。
  activeLayerId: string;
}
