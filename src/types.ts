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
  /**
   * このグループを「差分スタック」＝レイヤーの横軸として扱う。
   * 設定されていれば children は上下(z順)ではなく左右に並ぶ相互排他な差分(variants)で、
   * 合成に参加するのは children[variantIndex] の 1 つだけ。他の差分は「そこに無い」ものとして
   * 扱われる（横に並んだレイヤーは互いに独立にしか存在しない、という関係）。
   * UI では 1 行に畳まれ、左右スライド／‹ › で並列の差分へ切り替える。
   * 省略時は通常のフォルダ（＝縦軸だけ）。値は常に children の範囲内へクランプして解釈する。
   *
   * スタック自身は「スロット」を表す純粋な容れ物なので visible=true / opacity=1 を保つ
   * （表示・不透明度・名前・クリップは、今そこに出ている差分レイヤー側が持つ）。
   * 合成では visible=false / opacity<=0 のときだけスロットごと非表示として扱い、
   * 中間の不透明度は使わない。
   *
   * 【不変条件】横軸の中に横軸は置かない（差分の差分を作らない）。
   * 入れ子 [[A|B]|C] は合成結果が平らな [A|B|C] と完全に一致し、増えるのは「グループ内で
   * どれを選んでいたかの記憶」だけ。表現力は増えないのに、1 次元のレイヤー一覧に階層を
   * 描く必要が生まれて読みにくくなるので、スロットへスロットを入れる操作は中身を平らに混ぜる
   * （moveNode / moveAsVariant / addVariant がこれを保証する）。
   * 縦軸(フォルダ)との入れ子は許す: 差分の中にフォルダ（＝この案は複数枚でできている）、
   * フォルダの中に差分（＝このグループのここだけが変わる）はどちらも必要な形。
   */
  variantIndex?: number;
}

/** レイヤーツリーのノード = リーフ(Layer) または フォルダ(LayerGroup)。 */
export type LayerNode = Layer | LayerGroup;

/**
 * 選択範囲マスク（投げ縄選択などで作る「描ける場所」の限定）。
 * キャンバス座標の矩形 (x,y,w,h) に対し、画素ごとの被覆率 0..255 を持つ（アンチエイリアス付き）。
 * bbox の外は被覆 0（＝選択外）。レイヤーではなくドキュメントに 1 つだけ持つ。
 *
 * 状態の一部なので、log から決定的に再構築できる（setSelection op が path から同じマスクを焼き直す）。
 */
export interface SelectionMask {
  x: number;
  y: number;
  w: number;
  h: number;
  data: Uint8Array; // 長さ = w*h。被覆率 0..255
}

/** エディタの完全な状態。replay により log から決定的に再構築できる。 */
export interface EditorState {
  width: number;
  height: number;
  layers: LayerNode[]; // 下から上（layers[0] が最背面）。フォルダで階層化される。
  activeLayerId: string;
  /**
   * 選択範囲（null/省略 = 選択なし＝どこにでも描ける）。ブラシ・消しゴム・塗りつぶし・投げ縄塗りは
   * ここが非 null のとき被覆率を掛けて書き込むので、選択の外には一切触れない。
   */
  selection?: SelectionMask | null;
}
