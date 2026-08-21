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

/**
 * 合成方法（ブレンドモード）。
 *   normal   … 素直に上へ重ねる（source-over）
 *   multiply … 下にある合成結果と掛け算する（影・線画の「乗算」。白は透け、黒は残る）
 * 省略は normal と同じ意味。既存の state / log は blendMode を持たないので、
 * 「省略 = normal」を守る限り古いログもそのまま replay できる。
 */
export type BlendMode = 'normal' | 'multiply';

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
   * 合成方法（省略 = 'normal'）。非破壊（合成規則）で画素は書き換えないため、
   * 状態から決定的に決まり replay 一致に影響しない（clipped と同じ扱い）。
   */
  blendMode?: BlendMode;
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
  // 折りたたみ(collapsed)はここには持たない。見た目にしか影響しない純粋な UI の状態なので、
  // state に置くと開閉のたびに op が 1 つ積まれ、undo 1 回ぶんを食う（絵は何も変わらないのに）。
  // 開閉は CanvasEditor がローカルに覚える。
  children: LayerNode[];
  /**
   * 合成方法（省略 = 'normal'）。グループは子を独立バッファへ合成してから重ねる（isolation）ので、
   * ここでの multiply は「フォルダの合成結果まるごとを下地に掛ける」意味になる。
   */
  blendMode?: BlendMode;
  /**
   * 空スロット。「この行には何も無い」を、フラグではなく**選べる中身**として表す（children は常に空）。
   *
   * 横に並ぶ差分は互いに排他なので、中身ごとの表示/非表示は意味を持たない（出ていない差分の
   * 非表示フラグは誰にも効かず、スライドして出した瞬間に「出したのに何も無い」になる）。
   * 「非表示にして残す」はスロットが置き換える手管理そのものなので、無い状態は空スロットで表す:
   *   - 状態が「この行では何も出さない」を選べる（＝所属の宛先になれる）
   *   - 行として一時的に消すのは、スロット側の visible（＝行ごと）に任せる
   * 空のフォルダなので合成は何も出さず、既存のツリー操作（移動・削除・D&D）がそのまま使える。
   */
  empty?: boolean;
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

// ---- 状態(state)と所属(attachment) — 別の行にいる差分どうしの関係 -------------

/**
 * 状態 (state) — `ver1` / `ver2` のような**名前を持つ対象**。スロットがくっつく先。
 *
 * レイヤーの集合を写し取った記録ではない。「どのレイヤーがこの版に入っていたか」を
 * 覚えるのではなく、スロットの側が「私はこの状態に属している」という関係を持つ。
 */
export interface VariantState {
  id: string;
  name: string;
}

/**
 * 所属 (attachment) — 「状態 stateId は、行 stackId ではスロット slotId を使う」という関係。
 *
 * 指しているのは**行の中のスロット**であって、レイヤーそのものではない。slotId は差分スタックの
 * 子の id ＝「その枠」の id なので、枠の中身を何枚から 1 枚へ統合しても枠は残り、関係が壊れない
 * （レイヤーカンプがレイヤーの識別子を外部に持つために統合で黙って壊れるのと、ここが決定的に違う）。
 *
 * - 同じ (stateId, stackId) の組は最大 1 つ。
 * - 組が無い＝その状態はその行で「どのスロットも選ばない」。これは壊れではなく許される状態
 *   （影の差分が両方とも非表示で、ver1 でも ver2 でもないファイルが実在する）。
 * - スロットが 1 つしかない行（＝差分スタックですらない普通のレイヤー / フォルダ）は
 *   全状態で自動的に共有されるので、所属を持たない。宣言も操作も要らない。
 * - 状態を消すと、付いていた所属が一斉に外れる（記録が消えるのではなく、関係が切れる）。
 */
export interface Attachment {
  stateId: string;
  /** 行（差分スタック）の id。 */
  stackId: string;
  /** その行の中のスロット（= stack.children の要素）の id。 */
  slotId: string;
}

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
  /**
   * 名前を持つ状態の並び（省略・空 = 状態なし）。順序は UI 上の並び順で、意味を持たない。
   * 古い log は持たないので「省略 = 状態なし」を守る限りそのまま replay できる。
   */
  states?: VariantState[];
  /**
   * 所属の集合（スロットと状態の関係）。状態から見た「各行でどのスロットを使うか」の表。
   * 木の側には一切書き込まないので、レイヤーを動かしても統合しても関係の側は無傷でいられる。
   */
  attachments?: Attachment[];
}
