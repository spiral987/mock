import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  MutableRefObject,
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type {
  BBox,
  EditorState,
  ImageBuffer,
  Layer,
  LayerGroup,
  LayerNode,
  Operation,
  SelectionMask,
  StrokePoint,
  VariantState,
} from '../types';
import type { EditorSession } from '../session';
import { applyOperation } from '../engine/operation';
import {
  createAddImageLayerOp,
  createAddLayerOp,
  createBrightnessOp,
  createBrushOp,
  createEraserOp,
  createHueOp,
  createTranslateOp,
  createSetLayerVisibilityOp,
  createSetLayerOpacityOp,
  createSetLayerClippingOp,
  createSetLayerBlendModeOp,
  createRenameLayerOp,
  createRemoveLayerOp,
  createReorderLayerOp,
  createClearLayerOp,
  createMergeDownLayerOp,
  createMoveNodeOp,
  createAddGroupOp,
  createSetGroupCollapsedOp,
  createFillOp,
  fillRegion,
  createTransformOp,
  createSetCanvasSizeOp,
  createAddVariantOp,
  createSetVariantIndexOp,
  createRemoveVariantOp,
  createMoveAsVariantOp,
  createLassoFillOp,
  createSetSelectionOp,
  createClearSelectionOp,
  createAddStateOp,
  createRemoveStateOp,
  createRenameStateOp,
  createSetAttachmentOp,
  createApplyStateOp,
  type TransformParams,
} from '../engine/operations';
import {
  listStates,
  liveAttachment,
  liveAttachmentsOf,
  stateSatisfied,
  railCell,
  attachTarget,
  type RailCell,
} from '../engine/variantState';
import {
  selectionArea,
  selectionBounds,
  traceSelectionOutline,
  maskStamp,
  type SelectionMode,
} from '../engine/selection';
import { genId } from '../util/id';
import {
  layerContentBBox,
  isGroup,
  collectLeafIds,
  collectNodeIds,
  isVariantStack,
  isEmptySlot,
  activeVariant,
  variantIndexOf,
} from '../engine/layer';
import {
  getLayer,
  getNode,
  updateNode,
  getParentInfo,
  getSlotInfo,
  getVariantStackOf,
} from '../engine/editorState';
import { flattenState, compositeLayer } from '../engine/composite';
import { rasterizeSegment, stampDab, type StampFn } from '../engine/strokeRaster';
import {
  resolveProfile,
  createBrushStamp,
  createEraseStamp,
  sameSettings,
  BRUSH_DEFAULTS,
  BRUSH_SETTING_FIELDS,
  PAPER_SEED,
  type BrushProfile,
  type BrushSettings,
  type BrushType,
} from '../engine/brushProfile';
import { clampBBox, padBBox, strokesBBox, unionBBox } from '../engine/geom';
import { compositeToCanvas, compositeRegionToCanvas } from './render';
import { bufferToDataURL } from './thumbnail';
import { reorderIndex } from './layerDnd';
import { ColorPicker } from './ColorPicker';
import { FloatWindow, Section } from './Float';
import { ToolIcon, type ToolIconName } from './ToolIcon';
import { drawMarchingAnts, antsDash, ANTS_STEPS } from './marchingAnts';

type Tool =
  | 'brush'
  | 'gpen'
  | 'pencil'
  | 'airbrush'
  | 'eraser'
  | 'bucket'
  | 'lassoFill'
  | 'eyedropper'
  | 'line'
  | 'rect'
  | 'lassoSelect'
  | 'transform';

interface ToolDef {
  id: Tool;
  label: string;
  key: string;
  icon: ToolIconName;
  /** ツールチップ2行目（何をする道具か）。 */
  hint: string;
}

/**
 * ツールの一覧。役割ごとにグループへ分け、パレットは「アイコンのグリッド + 見出し」で出す。
 * 名前とショートカットはツールチップに入れる（ボタンに文字を並べると縦に伸びて探しにくいため）。
 */
const TOOL_GROUPS: { label: string; tools: ToolDef[] }[] = [
  {
    label: '描く',
    tools: [
      { id: 'brush', label: 'ブラシ', key: 'B', icon: 'brush', hint: '素直な丸筆' },
      { id: 'gpen', label: 'Gペン', key: 'N', icon: 'gpen', hint: '入り抜きの効く硬いペン' },
      { id: 'pencil', label: '鉛筆', key: 'P', icon: 'pencil', hint: '紙目の残る鉛筆' },
      { id: 'airbrush', label: 'エアブラシ', key: 'A', icon: 'airbrush', hint: '重ねて濃くする霧' },
    ],
  },
  {
    label: '消す・塗る',
    tools: [
      { id: 'eraser', label: '消しゴム', key: 'E', icon: 'eraser', hint: 'アクティブレイヤーを消す' },
      { id: 'bucket', label: '塗りつぶし', key: 'G', icon: 'bucket', hint: '同じ色の連結領域を塗る' },
      {
        id: 'lassoFill',
        label: '投げ縄塗り',
        key: 'U',
        icon: 'lassoFill',
        hint: '囲った内側をそのまま塗る（線が閉じていなくてよい）',
      },
      { id: 'eyedropper', label: 'スポイト', key: 'I', icon: 'eyedropper', hint: '画面の色を拾う' },
    ],
  },
  {
    label: '図形',
    tools: [
      { id: 'line', label: '直線', key: 'L', icon: 'line', hint: 'ドラッグで直線' },
      { id: 'rect', label: '矩形', key: 'R', icon: 'rect', hint: 'ドラッグで長方形の外周' },
    ],
  },
  {
    label: '選択・変形',
    tools: [
      {
        id: 'lassoSelect',
        label: '投げ縄選択',
        key: 'M',
        icon: 'lassoSelect',
        hint: '囲った内側だけ描けるようにする（Shift=追加 / Alt=削除 / Shift+Alt=交差）',
      },
      { id: 'transform', label: '変形', key: 'V', icon: 'transform', hint: '移動・拡大縮小・回転' },
    ],
  },
];

const TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);

/** 投げ縄の点列を間引くしきい値(px)。これ未満しか動いていない点は捨てる（多角形の辺を減らす）。 */
const LASSO_MIN_STEP = 1.5;


/**
 * 描画色の枠。'transparent' は色ではなく「アルファを削る」指定で、
 * どの筆で描いてもその筆の質感のまま消しゴムとして働く。
 */
type ColorSlot = 'main' | 'sub' | 'transparent';

/**
 * レイヤー行への落とし方。above/below は縦（z順）の並べ替え、into はフォルダの中へ。
 * left/right は「横に並べる」＝そのスロットの差分（variant）にする。
 */
type DropPos = 'above' | 'below' | 'into' | 'left' | 'right';

// S 押下中にキャンバスを上下ドラッグして太さ調整するときの感度（ドラッグpx → 太さ変化量）。
// MergeView と同じ操作感に揃える。
const SIZE_DRAG_FACTOR = 0.5;

// レイヤー行サムネイルの表示サイズ(px)。生成は高DPIで滲まないよう2倍解像度で焼く。
// CSS の .layer-thumb と一致させること（行の高さはほぼこの値で決まる）。
const LAYER_THUMB_W = 48;
const LAYER_THUMB_H = 36;

// レイヤー行のジェスチャ開始しきい値(px)。これ未満の移動はクリック（選択/リネーム/ボタン）として扱う。
const LAYER_GESTURE_THRESHOLD = 4;

// 行を「持ち上げる」までの長押し時間(ms)。
//
// 移動（並べ替え・フォルダ出し入れ・横へずらして差分化）と、差分の左右スライドは、どちらも
// 同じ行を掴む操作なので、向きで分けると斜めのドラッグが常に曖昧になる。そこで【時間】で分ける:
//   押してすぐ動かす → スライド（差分の切り替え）
//   押したまま待つ  → 持ち上がる → 以後は移動
// 持ち上げは構造を変える操作なので、少し溜めがある方が誤操作も減る。
// ⠿ グリップから掴んだときは待たずに持ち上がる（マウスで素早く並べ替えたいとき用）。
const LAYER_LIFT_MS = 330;

// レイヤーを「横へ持っていく」と判定する横移動量(px)。掴んだ位置からこれ以上ずらして他の行へ
// 落とすと、縦に積むのではなく横に並ぶ差分になる（＝そのスロットの variant になる）。
//
// 落とし先の行の中の絶対位置（左端/右端の帯）で判定しないのは、掴む場所（⠿ グリップ）が行の
// 左端にあるため。そこを掴んで縦にドラッグすると、通り過ぎる行すべてで「左」判定に入ってしまう。
// 「横へずらす」という手の動きそのものを見れば、どこを掴んでも意図どおりに分かれる。
const VARIANT_DROP_DX = 40;

// カルーセルのサムネイル 1 枚ぶんの間隔(px)。＝スライドで 1 段ずらすのに必要な距離でもある
// （指の移動量とサムネイルの移動量が 1:1 になるので、どこまで動かせば隣かが目で分かる）。
// CSS の .vc-chip の幅 + gap と一致させること（= LAYER_THUMB_W + 6）。
const VARIANT_PITCH_PX = 54;

// ---- 状態のレール（行の左を縦に走る線）の寸法 --------------------------------
// 状態ごとに 1 本の縦線をリストの左に立て、行との交点に印を打つ。点と点を総当たりで
// 結ぶ（メッシュ）のではなく 1 本に束ねるのは、(1) 状態そのものを押せる対象にできる、
// (2)「所属していない」が線の途切れとして見える、(3) 線が交差しない、の 3 点のため。
const RAIL_PITCH = 16; // レール間隔(px)
const RAIL_PAD_L = 9; // 一番左のレールまでの余白(px)
const RAIL_PAD_R = 7; // 最後のレールと行の間の余白(px)
const RAIL_KNOB_R = 4.5; // スロット行の印（丸）の半径(px)
const RAIL_DOT_R = 2.6; // 開いたスロットの中の 1 枚に打つ点の半径(px)
// 区間の上下に足す延長(px)。1 区間は「最初の行の上端〜最後の行の下端」を 1 本で引くので
// 区間の中では継ぎ目が出ない。この延長は端を行の枠（.layer-item の縦 padding）まで届かせるための分で、
// 途切れ（＝所属していない行）は行の高さぶんそのまま空くので、延ばしても潰れない。
const RAIL_BRIDGE = 7;

// レールの色。状態の名札(swatch)と同じ色を使い、「どのレールがどの状態か」を
// 位置ではなく色で対応させる（名前の幅はレール間隔に収まらないため）。
const RAIL_COLORS = ['#7ec7a8', '#e0a75e', '#b28fe0', '#5b9dff', '#e07a7a', '#8fd0e0'];
const railColor = (i: number) => RAIL_COLORS[i % RAIL_COLORS.length];

// キャンバス1辺の上限（画素）。ブラウザの canvas 制限（Chrome ~16384/辺）に合わせた安全上限。
// 実際には総面積・メモリ（1レイヤ = w*h*4 byte）が先に効くので、大きい値は自己責任で。
const MAX_CANVAS_DIM = 16384;

// 解像度テスト用のプリセット（正方形は各辺、それ以外は明示）。
const CANVAS_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '900×600', w: 900, h: 600 },
  { label: 'FHD', w: 1920, h: 1080 },
  { label: '2K²', w: 2048, h: 2048 },
  { label: '4K²', w: 4096, h: 4096 },
  { label: '8K²', w: 8192, h: 8192 },
];

// ---- Transform ツール（移動・拡大縮小・回転を1ツールに統合） ----
// 1ドラッグ = 1操作。move は非破壊の translate、scale/rotate は transform（resample）として確定する。
type XformGesture =
  | { mode: 'move'; startX: number; startY: number; bbox: BBox; dx: number; dy: number }
  | {
      mode: 'scale';
      corner: { x: number; y: number }; // 掴んだ頂点（ジェスチャ開始時）
      fixed: { x: number; y: number }; // 固定点 = 対角の頂点
      bbox: BBox;
      matrix: TransformParams | null;
    }
  | {
      mode: 'rotate';
      pivot: { x: number; y: number }; // 回転中心 = bbox 中心
      startAngle: number;
      bbox: BBox;
      matrix: TransformParams | null;
    };

type XformHit = { mode: 'scale'; corner: number } | { mode: 'rotate' } | { mode: 'move' };

// ハンドルの当たり判定・描画サイズ（スクリーンpx。使用時に zoom で割って canvas 座標へ換算する）。
const XF_CORNER_PX = 10;
const XF_EDGE_PX = 6;
const XF_HANDLE_PX = 7;

/** bbox の4頂点（TL, TR, BR, BL の順）。 */
function bboxCorners(b: BBox): [number, number][] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

/** 点 (px,py) と線分 (ax,ay)-(bx,by) の距離。 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/** スケール係数のクランプ（符号維持。0 への退化と極端な拡大を防ぐ）。 */
function clampScale(s: number): number {
  const sign = s < 0 ? -1 : 1;
  return sign * Math.min(32, Math.max(0.01, Math.abs(s)));
}

/** 行列合成 m2 ∘ m1（m1 を適用してから m2）。x'=a*x+c*y+e 表現。 */
function composeMatrix(m2: TransformParams, m1: TransformParams): TransformParams {
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  };
}

/** ほぼ恒等変換か（確定をスキップして空opを残さない）。 */
function nearIdentity(m: TransformParams): boolean {
  return (
    Math.abs(m.a - 1) < 1e-4 &&
    Math.abs(m.b) < 1e-4 &&
    Math.abs(m.c) < 1e-4 &&
    Math.abs(m.d - 1) < 1e-4
  );
}

/**
 * レイヤー操作ボタン（アイコン + 4文字ラベル）。
 *
 * レイヤーパネルの上に並ぶ「構造をいじる操作」は数が多く、文字だけのボタンを一列に流すと
 * どれがどれだか探せなくなる。アイコンで形を、ラベルで意味を、title で効き方を出す3段構えにして、
 * 同じ見た目のボタンをグリッドに揃える。
 */
function LayerOpButton({
  icon,
  label,
  title,
  onClick,
  disabled,
  on,
  tone,
}: {
  icon: ToolIconName;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** 押しっぱなしに見せる（クリッピングが効いている間など）。 */
  on?: boolean;
  /**
   * 点いているときの色。効いている状態が複数あるので、同じ色で並べると何が有効なのか読めない。
   * 行に出す印（非 / 乗 / ⤵）と同じ色に揃えて、上と下で対応が取れるようにする。
   */
  tone?: 'off' | 'mul' | 'clip';
}) {
  return (
    <button
      className={`layer-op${on ? ' on' : ''}${tone ? ` tone-${tone}` : ''}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <ToolIcon name={icon} size={16} />
      <span>{label}</span>
    </button>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function CanvasEditor({
  session,
  width,
  height,
  version,
  onEdit,
  onLoadPsdDocument,
}: {
  session: EditorSession;
  width: number;
  height: number;
  version: number;
  onEdit: () => void;
  onLoadPsdDocument: (w: number, h: number, ops: readonly Operation[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  // pan(視点移動)を担う外側ラッパ。ジェスチャ中は style.transform を命令的に書き換え、React 再レンダーを
  // 挟まない（ブラシカーソル等と同じ方式）。zoom は内側 .canvas-pan の scale が担う。
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const psdInputRef = useRef<HTMLInputElement>(null);
  // 中ボタン/Space ドラッグによるパン中の状態。
  const panningRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  // pan ジェスチャ実行中フラグ。true の間は panRef を state から上書きせず（命令的更新を正とする）、
  // ジェスチャ終了時に一度だけ setPan で React state へ確定する。
  const panGestureRef = useRef(false);
  // ホイール pan は pointerup が無いので、入力が止んだら確定するデバウンスタイマ。
  const wheelPanTimerRef = useRef<number | null>(null);
  const snapshotRef = useRef<HTMLCanvasElement | null>(null);
  const strokeLayerRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef<{ strokes: StrokePoint[] } | null>(null);
  // Transform ツールのドラッグ中ジェスチャ（面=移動 / 頂点=拡大縮小 / 辺=回転）。
  const xformRef = useRef<XformGesture | null>(null);
  const xformRafRef = useRef<number | null>(null);
  // 連続する変形ジェスチャの統合用。直前に確定した変形 op の id と、元バッファからの累積行列。
  // 同一ストリークが続く限り元バッファから1回だけ再サンプルし直すことで、回転の反復による
  // バッファ肥大・再サンプル累積（解像度低下）を防ぐ。
  const xformStreakRef = useRef<{ opId: string; cumulative: TransformParams } | null>(null);
  // ストリーク開始時（最初の変形 op を適用する直前）の状態。継続ジェスチャは全ログ replay せず
  // applyOperation(baseState, op) で元バッファから1回だけ再サンプルし直す（確定の重さ対策）。
  const xformBaseStateRef = useRef<EditorState | null>(null);
  const shapeRef = useRef<{ startX: number; startY: number } | null>(null);
  // 投げ縄（選択 / 塗り）のドラッグ中。点列はキャンバス座標の平坦配列 [x0,y0,x1,y1,...]。
  // 離した時点で 1 op（setSelection / lassoFill）として確定する = Undo 1 回で元に戻る。
  const lassoRef = useRef<{ pts: number[]; kind: 'select' | 'fill'; mode: SelectionMode } | null>(
    null,
  );
  // 選択範囲・投げ縄ドラッグを描く重ね canvas（絵の canvas を汚さないので、点線を動かしても再合成が要らない）。
  const selCanvasRef = useRef<HTMLCanvasElement>(null);
  // マーチングアンツ（動く点線）の位相。
  const antsPhaseRef = useRef(0);
  // 選択マスク → 輪郭ループのキャッシュ（マスクの参照が変わったときだけ再計算する）。
  const outlineCacheRef = useRef<{ sel: SelectionMask | null; loops: number[][] } | null>(null);
  // S キー押下中の「太さ調整モード」での上下ドラッグ（押下時の clientY と太さを控える）。
  const sizeDragRef = useRef<{ startY: number; startSize: number } | null>(null);
  // Z キー押下中の「ズームモード」での上下ドラッグ（押下時の clientY・倍率・カーソル位置を控える）。
  const zoomDragRef = useRef<{ startY: number; startZoom: number; anchorX: number; anchorY: number } | null>(
    null,
  );
  // レイヤーパネルの D&D 並べ替えでドラッグ中のノード id。
  const dragIdRef = useRef<string | null>(null);
  // ドラッグを掴んだ位置（クライアント座標）。ここからの横移動量で「縦に積む／横に並べる」を分ける。
  const dragOriginRef = useRef<{ x: number; y: number } | null>(null);
  // 行のどこを掴んでもドラッグできるよう、pointerdown 時点では「保留」にしておき、しきい値を
  // 超えて動いたら本ドラッグを開始する（それ未満はクリック＝選択/リネーム/ボタン操作として扱う）。
  const pendingDragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    pointerId: number;
    /** 長押しの計測対象の行要素（タイマー発火時に pointer を捕捉するため控える）。 */
    el: HTMLElement;
  } | null>(null);
  // 長押しで持ち上がるまでのタイマー。動き出す／離す／スライドに入ると取り消す。
  const liftTimerRef = useRef<number | null>(null);
  // 直前のジェスチャ（差分の左右スライド / 持ち上げての移動）がこのポインタ操作を使い切ったか。
  //
  // 行は「クリックで選ぶ」ようになっているが、pointer capture 中の click は掴んだ行へ飛んでくるので、
  // スライドや移動のあとにも click が 1 発届く。それを選択として処理すると、click ハンドラが握って
  // いるのは【スライド前】に出ていた差分なので、切り替えたばかりの差分をその場で元へ戻してしまう。
  // ジェスチャを完了した時に立て、次の pointerdown で落とす。
  const gestureConsumedRef = useRef(false);
  // 差分の左右スライド中（持ち上げる前に横へ動かしたとき）。
  const swipeRef = useRef<{
    stackId: string;
    pointerId: number;
    startX: number;
    baseIndex: number;
    count: number;
    index: number;
    /** 端でクランプ済みの横移動量。カルーセルの位置はこれだけで決まる。 */
    dx: number;
  } | null>(null);
  // ドラッグ中に pointer へ追従する半透明ゴースト要素。
  const ghostRef = useRef<HTMLDivElement>(null);
  // レイヤー行サムネイルのキャッシュ（node.id → 署名+dataURL）。内容が変わった行だけ再生成する。
  const thumbCacheRef = useRef(new Map<string, { sig: string; url: string }>());
  // バッファ参照ごとに安定した連番 id を振る（構造共有により、未変更レイヤーは参照が保たれる）。
  const bufIdRef = useRef(new WeakMap<ImageBuffer, number>());
  const bufSeqRef = useRef(0);

  const [tool, setTool] = useState<Tool>('brush');
  const [sizeAdjust, setSizeAdjust] = useState(false); // S キー押下中 = 太さ調整モード
  const [zoomKey, setZoomKey] = useState(false); // Z キー押下中 = ズームモード
  const [spaceHeld, setSpaceHeld] = useState(false); // Space 長押し = 視点移動（パン）モード

  // ---- 描画色: メイン / サブ / 透明 の3枠（クリスタと同じ持ち方） --------------
  // 「透明」は色ではなく "アルファを削る" 指定。選ぶと、いま持っている筆がその質感のまま
  // 消しゴムになる（Gペンなら Gペンの入り抜きで、鉛筆なら紙目を残したまま消える）。
  const [mainColor, setMainColor] = useState('#e23b3b');
  const [subColor, setSubColor] = useState('#ffffff');
  const [colorSlot, setColorSlot] = useState<ColorSlot>('main');
  // 透明から色へ戻るときの行き先（直前に使っていた色枠）。
  const inkSlotRef = useRef<'main' | 'sub'>('main');
  if (colorSlot !== 'transparent') inkSlotRef.current = colorSlot;
  /** いま描く色。透明を選んでいる間も「戻る先の色」を指す（カーソル表示やピッカーの対象）。 */
  const color = (colorSlot === 'sub' || (colorSlot === 'transparent' && inkSlotRef.current === 'sub'))
    ? subColor
    : mainColor;
  const transparentInk = colorSlot === 'transparent';
  /** この一筆はアルファを削るか（消しゴムツール、または透明色を選んでいるとき）。 */
  const erasing = transparentInk || tool === 'eraser';

  /** 色を差し替える（スポイト・カラーピッカー・パレット共通）。透明を選んでいたら色枠へ戻す。 */
  const setColor = (hex: string) => {
    const slot = colorSlot === 'transparent' ? inkSlotRef.current : colorSlot;
    if (slot === 'sub') setSubColor(hex);
    else setMainColor(hex);
    if (colorSlot === 'transparent') setColorSlot(slot); // 拾った色ですぐ描けるようにする
  };

  /** X: メイン ⇄ サブ（透明を選んでいるときは直前の色枠へ戻る）。 */
  const toggleMainSub = () =>
    setColorSlot((s) => (s === 'transparent' ? inkSlotRef.current : s === 'main' ? 'sub' : 'main'));
  /** C: 透明 ⇄ 直前の色枠。 */
  const toggleTransparent = () =>
    setColorSlot((s) => (s === 'transparent' ? inkSlotRef.current : 'transparent'));

  // size はツールごとに保持する（Brush と Eraser で別々の太さを記憶）。
  const [sizes, setSizes] = useState<Record<string, number>>({
    brush: 6,
    gpen: 7,
    pencil: 4,
    airbrush: 34, // エアブラシは広く薄く乗せる道具なので既定を大きめに
    eraser: 16,
    line: 4,
    rect: 4,
  });
  const [opacity, setOpacity] = useState(1);
  const [tolerance, setTolerance] = useState(24);
  const [activeLayerId, setActiveLayerId] = useState(session.state.activeLayerId);
  // レイヤー操作ボタンの対象（＝いま選んでいる行）。
  //
  // 行の中にボタンを置かず、操作は全部パネル上部のボタン群へ集約している（行は掴む・眺める場所に
  // しておきたいので、押せる小物を並べない）。そのぶん「どの行に効くのか」を state で持つ必要がある。
  // 描き先(activeLayerId)と分けているのは、描き先は必ずリーフである一方、操作の対象はフォルダや
  // スロットにもなる（フォルダごと乗算、フォルダごと削除）から。リーフを選べば両方が一緒に動く。
  const [selectedId, setSelectedId] = useState(session.state.activeLayerId);
  // 差分を「覗き見」している状態。state は変えず、いまどの差分が出るかだけを差し替える
  // （離す/クリックで初めて 1 op として確定＝見比べても履歴が汚れない）。
  const [variantPeek, setVariantPeek] = useState<{ stackId: string; index: number } | null>(null);
  const variantPeekRef = useRef<{ stackId: string; index: number; baseIndex: number } | null>(null);
  // 左右スライド中のスロット（カルーセルを出す対象）。
  const [swipingStackId, setSwipingStackId] = useState<string | null>(null);
  // カルーセルの帯。指の動きに毎フレーム追従させるので、再レンダーを挟まず transform を直接書く。
  const carouselTrackRef = useRef<HTMLDivElement>(null);
  const [hovering, setHovering] = useState(false);
  const [zoom, setZoom] = useState(1);
  // パン(視点移動)は scroll ではなく transform で行う（キャンバスが画面に収まっていても動かせる）。
  // pan = キャンバス左上のビューポート左上からのオフセット(px)。
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [opacityDraft, setOpacityDraft] = useState<{ id: string; v: number } | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // 状態の名札を書き換え中（ダブルクリックで入る）。
  const [editingStateId, setEditingStateId] = useState<string | null>(null);
  const [editingStateName, setEditingStateName] = useState('');
  // レール描画のために測った行の位置。木の入れ子（＝行ごとに左端の x が違う）に依存せず
  // 線を引きたいので、CSS で段組みするのではなく実測して SVG に描く。
  const layerTreeRef = useRef<HTMLDivElement | null>(null);
  const [railRows, setRailRows] = useState<{ id: string; y: number; h: number }[]>([]);
  // レイヤー D&D 中のドロップ位置ヒント（対象ノード id と、その上/下/中/左/右への挿入）。
  const [dropHint, setDropHint] = useState<{ id: string; pos: DropPos } | null>(null);
  // 持ち上げ中の行（null = 掴んでいない）。ゴーストの表示と、持ち上がった行の見た目に使う。
  const [dragGhost, setDragGhost] = useState<{ id: string; name: string } | null>(null);
  // キャンバスサイズ入力の下書き（Apply で確定）。remount 時に現在サイズで初期化される。
  const [wDraft, setWDraft] = useState(String(width));
  const [hDraft, setHDraft] = useState(String(height));
  // ドラッグ中の不透明度プレビュー（再レンダーを介さず合成へ反映するため ref）。
  const opacityPreviewRef = useRef<{ layerId: string; opacity: number } | null>(null);

  // 筆で描くツール（= brush op を出す）。line/rect も同じ経路だが形状ツールとして別扱い。
  const PAINT_TOOLS: Tool[] = ['brush', 'gpen', 'pencil', 'airbrush'];
  const isPaintTool = (t: Tool) => PAINT_TOOLS.includes(t);
  /** ツール → 筆の質感。line/rect など質感を持たないものは 'pen'。 */
  const brushTypeOf = (t: Tool): BrushType =>
    t === 'gpen' ? 'gpen' : t === 'pencil' ? 'pencil' : t === 'airbrush' ? 'airbrush' : 'pen';
  const brushType = brushTypeOf(tool);
  /** いま選んでいるツールの表示名（パネルの見出し・ラベルはこれを使う）。 */
  const toolLabel = TOOLS.find((t) => t.id === tool)?.label ?? tool;
  const showCursor = isPaintTool(tool) || tool === 'eraser' || tool === 'line' || tool === 'rect';
  // 筆ごとの質感パラメータ（ツールプロパティで編集する）。値は op に焼き込まれるので、
  // 後からここを変えても過去の op は当時の質感のまま replay される。
  const [brushTuning, setBrushTuning] = useState<Record<BrushType, BrushSettings>>(() => ({
    pen: { ...BRUSH_DEFAULTS.pen },
    gpen: { ...BRUSH_DEFAULTS.gpen },
    pencil: { ...BRUSH_DEFAULTS.pencil },
    airbrush: { ...BRUSH_DEFAULTS.airbrush },
  }));
  const brushSet = brushTuning[brushType];
  /**
   * 消す op に焼き込む質感。消しゴムツールは従来どおり素の硬い円（＝省略＝pen プリセット）、
   * 「透明色」で筆を使ったときだけ、その筆の質感をそのまま持ち込む。
   */
  const eraserTexture = (): { brushType?: BrushType; brush?: BrushSettings } =>
    tool === 'eraser' ? {} : { brushType, brush: brushSet };
  const setBrushField = (key: keyof BrushSettings, v: number) =>
    setBrushTuning((prev) => ({ ...prev, [brushType]: { ...prev[brushType], [key]: v } }));
  const resetBrushTuning = () =>
    setBrushTuning((prev) => ({ ...prev, [brushType]: { ...BRUSH_DEFAULTS[brushType] } }));
  // スポイトから戻る先。直前に使っていた筆を覚えておく（既定はブラシ）。
  const lastPaintToolRef = useRef<Tool>('brush');
  if (isPaintTool(tool)) lastPaintToolRef.current = tool;

  // 現在ツールの size（size を使うツールのみ。それ以外はフォールバック値）。
  const size = sizes[tool] ?? 8;
  const setSize = (v: number | ((s: number) => number)) =>
    setSizes((prev) => {
      const cur = prev[tool] ?? 8;
      const next = typeof v === 'function' ? v(cur) : v;
      return { ...prev, [tool]: Math.max(1, Math.min(80, Math.round(next))) };
    });

  // アートボードは常に1枚、stage 原点(0,0)に置く。
  const focusX = 0;
  const focusY = 0;

  // 表示用 state（不透明度プレビューを一時的に上書き。ツリー対応）。
  const displayState = (): EditorState => {
    let st = session.state;
    const pv = opacityPreviewRef.current;
    if (pv) st = updateNode(st, pv.layerId, (n) => ({ ...n, opacity: pv.opacity }));
    // 差分サムネイルを覗き見中は、まだ確定していない差分を仮に出して見せる
    // （クリックで初めて 1 op として確定する）。
    const vp = variantPeekRef.current;
    if (vp && vp.index !== vp.baseIndex) {
      st = updateNode(st, vp.stackId, (n) => (isGroup(n) ? { ...n, variantIndex: vp.index } : n));
    }
    return st;
  };

  // Transform ツール用: アクティブレイヤー内容の bbox。layerContentBBox は全画素走査なので
  // ホバー毎ではなくここで1回だけ計算してキャッシュする（内容が空なら null）。
  const activeContentBBox = useMemo<BBox | null>(() => {
    if (tool !== 'transform') return null;
    const layer = getLayer(session.state, activeLayerId);
    if (!layer) return null;
    const bb = layerContentBBox(layer);
    return bb.w > 0 && bb.h > 0 ? bb : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, version, activeLayerId]);

  // 選択範囲の要約（パネル表示用）。面積の算出はマスク全走査なので、version ではなく
  // 「マスクの参照」を依存にする（描くたびに数百万画素を数え直さないため。選択を変えた時だけ走る）。
  const selectionMask = session.state.selection ?? null;
  const selectionInfo = useMemo<{ w: number; h: number; area: number } | null>(() => {
    if (!selectionMask) return null;
    const b = selectionBounds(selectionMask);
    return { w: b.w, h: b.h, area: selectionArea(selectionMask) };
  }, [selectionMask]);

  // Transform ツールの枠＋頂点ハンドル描画（quad は canvas 座標の4頂点）。
  // 線幅・ハンドルはスクリーンpx 基準（zoom で割って CSS 拡大後に一定サイズに見せる）。
  const drawXformBox = (c: HTMLCanvasElement, quad: [number, number][]) => {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = '#56ccf2';
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(quad[i][0], quad[i][1]);
    ctx.closePath();
    ctx.stroke();
    const hs = XF_HANDLE_PX / zoom;
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1 / zoom;
    for (const [x, y] of quad) {
      ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
      ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
    }
    ctx.restore();
  };

  const repaint = () => {
    const c = canvasRef.current;
    if (!c) return;
    compositeToCanvas(c, displayState());
    if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
  };

  // 部分再描画: 変化した矩形 region（キャンバス座標）だけを合成し直す。全面 flatten を避けるので、
  // 4K 以上でも編集の確定・不透明度変更・undo/redo が軽い。region が無い/広すぎる場合は全面にフォールバック。
  const repaintRegion = (region: BBox | null) => {
    const c = canvasRef.current;
    if (!c) return;
    if (!region) return repaint();
    const pad = 2; // AA・境界の取りこぼし対策に少しだけ広げる
    const x0 = Math.max(0, Math.floor(region.x - pad));
    const y0 = Math.max(0, Math.floor(region.y - pad));
    const x1 = Math.min(width, Math.ceil(region.x + region.w + pad));
    const y1 = Math.min(height, Math.ceil(region.y + region.h + pad));
    const rw = x1 - x0;
    const rh = y1 - y0;
    if (rw <= 0 || rh <= 0) {
      // アートボード内に可視の変化なし。overlay だけ描き直す。
      if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
      return;
    }
    // 領域が広いと windowing のオーバーヘッドが勝るので素直に全面。
    if (rw * rh >= width * height * 0.6) return repaint();
    compositeRegionToCanvas(c, displayState(), x0, y0, rw, rh);
    if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
  };

  // ブラシ/消しゴムの確定描画は全画面 flatten で、キャンバスが大きい・レイヤが多いほど重い（数十ms）。
  // これをストロークごと（pointer up 毎）に走らせると 1 本ごとに固まる。連続描画中はプレビュー最終
  // フレームが表示を担えるので、確定 flatten は「少しアイドルしてから 1 回だけ」に間引く（バーストを 1
  // 回にまとめる）。session.state は即時正しいので編集内容や書き出しには影響しない（表示だけ 90ms 遅延）。
  const deferExactRef = useRef(false);
  const exactTimerRef = useRef<number | null>(null);
  // 次の再描画で「変化した矩形」だけを描き直すためのヒント。null=未指定、'full'=全面必須、BBox=その領域。
  // 編集ハンドラが onEdit(version 更新) の前に markDirty で積む。version 効果 / 遅延確定がこれを消費する。
  const dirtyRegionRef = useRef<BBox | 'full' | null>(null);
  const markDirty = (r: BBox | 'full') => {
    if (r === 'full') {
      dirtyRegionRef.current = 'full';
      return;
    }
    const cur = dirtyRegionRef.current;
    if (cur === 'full') return;
    dirtyRegionRef.current = cur ? unionBBox(cur, r) : r;
  };
  // 溜まった dirty を消費して部分/全面を選び再描画する。
  const flushDirtyRepaint = () => {
    const dr = dirtyRegionRef.current;
    dirtyRegionRef.current = null;
    if (dr && dr !== 'full') repaintRegion(dr);
    else repaint();
  };
  const scheduleExactRepaint = () => {
    if (exactTimerRef.current !== null) clearTimeout(exactTimerRef.current);
    exactTimerRef.current = window.setTimeout(() => {
      exactTimerRef.current = null;
      deferExactRef.current = false;
      flushDirtyRepaint();
    }, 90);
  };
  useEffect(() => () => {
    if (exactTimerRef.current !== null) clearTimeout(exactTimerRef.current);
    if (wheelPanTimerRef.current !== null) clearTimeout(wheelPanTimerRef.current);
    if (liftTimerRef.current !== null) clearTimeout(liftTimerRef.current);
  }, []);

  // マウント時・編集後(version)・サイズ変更時に再描画。
  // ブラシ確定バースト中（deferExactRef）はプレビューが表示を担うので、全画面 flatten は間引く。
  // 編集ハンドラが markDirty で領域を指定していれば、その矩形だけを部分再描画する（未指定なら全面）。
  useEffect(() => {
    if (deferExactRef.current) return;
    flushDirtyRepaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, width, height]);

  // ツール・アクティブレイヤー変更時に再描画（Transform 枠の表示有無が変わる）。
  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, activeLayerId]);

  // ズームは純粋な CSS scale なので合成結果（画素）は変わらない。全面 flatten を毎ズームで走らせると
  // 4K 以上で極端に重くなるため、再描画するのは Transform 枠を出しているとき（ハンドルを一定スクリーン
  // サイズに描き直す必要がある）だけに限定する。それ以外のツールではズームで再合成しない。
  useEffect(() => {
    if (tool === 'transform') repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // ツール／アクティブレイヤーが変わったら変形ストリークを終了（別対象への統合を防ぐ）。
  useEffect(() => {
    xformStreakRef.current = null;
    xformBaseStateRef.current = null;
  }, [tool, activeLayerId]);

  // Undo/Redo 等でアクティブレイヤが存在しなくなったら現在状態の active に合わせる。
  // 選択（操作ボタンの対象）も消えていたら描き先へ寄せる（押した先が無いボタンを残さない）。
  useEffect(() => {
    if (!getNode(session.state, activeLayerId)) {
      setActiveLayerId(session.state.activeLayerId);
    }
    if (!getNode(session.state, selectedId)) {
      setSelectedId(session.state.activeLayerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const doUndo = () => {
    if (session.undo()) {
      markDirty(session.lastDirtyRegion ?? 'full'); // 変化領域が分かれば部分再描画
      onEdit(); // version 効果が flushDirtyRepaint（部分/全面）を実行する
    }
  };

  const doRedo = () => {
    if (session.redo()) {
      markDirty(session.lastDirtyRegion ?? 'full');
      onEdit();
    }
  };

  // ブラシカーソルのリングを pointer 位置へ追従（再レンダーを避け DOM を直接更新）。
  const moveCursor = (clientX: number, clientY: number) => {
    const ring = cursorRef.current;
    const pane = paneRef.current;
    if (!ring || !pane) return;
    const rect = pane.getBoundingClientRect();
    ring.style.left = `${clientX - rect.left}px`;
    ring.style.top = `${clientY - rect.top}px`;
  };

  // キーボードショートカット（入力欄フォーカス時は無効）。最新クロージャを ref 経由で呼ぶ。
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => {});
  kbRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
      return;
    }
    if (meta && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      doRedo();
      return;
    }
    // Ctrl/⌘+D = 選択解除（他のアプリと同じ割り当て。ブラウザのブックマーク追加は抑止する）。
    if (meta && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (meta) return; // 他の Ctrl/Cmd 系はブラウザに委ねる
    switch (e.key) {
      case 'b': case 'B': setTool('brush'); break;
      case 'n': case 'N': setTool('gpen'); break;
      case 'p': case 'P': setTool('pencil'); break;
      case 'a': case 'A': setTool('airbrush'); break;
      case 'e': case 'E': setTool('eraser'); break;
      case 'g': case 'G': setTool('bucket'); break;
      case 'u': case 'U': setTool('lassoFill'); break;
      case 'i': case 'I': setTool('eyedropper'); break;
      case 'l': case 'L': setTool('line'); break;
      case 'r': case 'R': setTool('rect'); break;
      case 'm': case 'M': setTool('lassoSelect'); break;
      case 'v': case 'V': setTool('transform'); break;
      case 'x': case 'X': toggleMainSub(); break;
      case 'c': case 'C': toggleTransparent(); break;
      // いま描いているレイヤーが属するスロットの差分を往復する（A/B をパタパタ見比べる）。
      case ',': stepActiveVariant(-1); break;
      case '.': stepActiveVariant(1); break;
      case '[': setSize((s) => Math.max(1, s - 2)); break;
      case ']': setSize((s) => Math.min(80, s + 2)); break;
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // S キーを押している間だけ「太さ調整モード」（MergeView と同じ操作感）。このモードでキャンバスを
  // ペン押下→上ドラッグで太く・下ドラッグで細く。入力欄フォーカス中・Ctrl/⌘併用時は無効。
  useEffect(() => {
    const isField = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || isField(e.target)) return;
      if (e.key === 's' || e.key === 'S') setSizeAdjust(true);
      if (e.key === 'z' || e.key === 'Z') setZoomKey(true);
      if (e.key === ' ') {
        setSpaceHeld(true);
        e.preventDefault(); // ページスクロール/ボタン誤発火を防ぐ
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 's' || e.key === 'S') setSizeAdjust(false);
      if (e.key === 'z' || e.key === 'Z') setZoomKey(false);
      if (e.key === ' ') setSpaceHeld(false);
    };
    const reset = () => {
      setSizeAdjust(false);
      setZoomKey(false);
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', reset);
    };
  }, []);

  // ---- ズーム / パン（視点移動。transform のみ。ログ・画素には影響しない） ----
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 8;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const panRef = useRef(pan);
  // pan ジェスチャ中は命令的更新（applyPan）が panRef を最新に保つので、途中の巻き添え再レンダーで
  // 古い state に巻き戻さない。非ジェスチャ時は通常どおり state と同期する。
  if (!panGestureRef.current) panRef.current = pan;
  const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

  // pan を命令的に適用する（React 再レンダーを介さず stage の transform を直接書き換える）。
  // これにより高頻度の wheel/ドラッグでも巨大コンポーネントの再レンダーが走らず、pan がなめらかになる。
  const applyPan = (p: { x: number; y: number }) => {
    panRef.current = p;
    const el = stageRef.current;
    if (el) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

  // pan ジェスチャを終える（保留中の確定タイマを止め、フラグを下ろす）。panRef.current は最新の
  // 命令的 pan 位置のままにしておく（呼び出し側が setPan する場合の基準になる）。
  const flushPanGesture = () => {
    if (wheelPanTimerRef.current !== null) {
      clearTimeout(wheelPanTimerRef.current);
      wheelPanTimerRef.current = null;
    }
    panGestureRef.current = false;
  };

  // pan ジェスチャの確定。命令的に動かした最終位置を React state へ書き戻す。
  const endPanGesture = () => {
    if (!panGestureRef.current) {
      flushPanGesture();
      return;
    }
    flushPanGesture();
    setPan(panRef.current);
  };

  // キャンバスが画面外に行き過ぎないよう pan を緩く制限（最低 marginだけ画面内に残す）。
  const clampPan = (p: { x: number; y: number }): { x: number; y: number } => {
    const vp = viewportRef.current;
    if (!vp) return p;
    const z = zoomRef.current;
    const cw = width * z;
    const ch = height * z;
    const m = 60;
    return {
      x: Math.max(m - cw, Math.min(vp.clientWidth - m, p.x)),
      y: Math.max(m - ch, Math.min(vp.clientHeight - m, p.y)),
    };
  };

  // 焦点タイルをビューポート中央に配置する pan を計算してセット（単一キャンバスは focusX/Y=0）。
  const centerView = (z = zoomRef.current) => {
    const vp = viewportRef.current;
    if (!vp) return;
    setPan({
      x: Math.round((vp.clientWidth - width * z) / 2 - focusX * z),
      y: Math.round((vp.clientHeight - height * z) / 2 - focusY * z),
    });
  };

  // anchor（スクリーン座標）を基準点に保ったままズーム。pan を調整して基準点が動かないようにする。
  const zoomToAnchor = (rawZoom: number, anchorClientX: number, anchorClientY: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    // 進行中の pan ジェスチャがあれば確定を打ち切る（panRef.current は最新の pan 位置のまま使う）。
    // これをしないと、保留中の pan 確定タイマが後から発火してズームで調整した pan を巻き戻してしまう。
    flushPanGesture();
    const z0 = zoomRef.current;
    const z1 = clampZoom(rawZoom);
    if (z1 === z0) return;
    const rect = vp.getBoundingClientRect();
    const ax = anchorClientX - rect.left;
    const ay = anchorClientY - rect.top;
    const p = panRef.current;
    const k = z1 / z0;
    setPan({ x: ax - (ax - p.x) * k, y: ay - (ay - p.y) * k });
    setZoom(z1);
  };

  const zoomByCenter = (factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    zoomToAnchor(zoomRef.current * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  const resetZoom = () => {
    setZoom(1);
    centerView(1);
  };

  const fitZoom = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    // アートボード1枚をビューポートにフィット。
    const z = clampZoom(Math.min((vp.clientWidth - 48) / width, (vp.clientHeight - 48) / height));
    setZoom(z);
    setPan({
      x: Math.round((vp.clientWidth - width * z) / 2),
      y: Math.round((vp.clientHeight - height * z) / 2),
    });
  };

  // マウント時（＝新規ドキュメント）に中央へ。リサイズ（canvasSize op）では recenter しない
  // ＝ドラッグで掴んだ辺がその場で伸縮して見えるように、視点は動かさない。
  useLayoutEffect(() => {
    centerView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /**
   * レイヤー行の位置を実測して、状態のレールを引くための座標を取る。
   *
   * CSS の段組みで左に列を作る手も考えたが、行の左端の x は入れ子の深さで変わる（フォルダの
   * padding とネスト枠のぶんずつ右へ寄る）ので、行の中に置いた印は深さごとにずれて
   * 「1 本の線」に見えなくなる。実測して 1 枚の SVG に描けば入れ子と無関係に真っ直ぐ引ける。
   *
   * 依存配列を置かず毎レンダー後に測り、値が変わらなければ setState しない（＝再レンダーの輪を作らない）。
   */
  const measureRails = useCallback(() => {
    const root = layerTreeRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect().top;
    const rows: { id: string; y: number; h: number }[] = [];
    // querySelectorAll は文書順＝画面の上から下の順で返るので、そのままレールの走る順になる。
    root.querySelectorAll<HTMLElement>('.layer-head[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      rows.push({ id: el.dataset.id ?? '', y: r.top - base, h: r.height });
    });
    setRailRows((prev) => {
      const same =
        prev.length === rows.length &&
        prev.every((p, i) => p.id === rows[i].id && p.y === rows[i].y && p.h === rows[i].h);
      return same ? prev : rows; // 変わっていなければ setState しない＝再レンダーの輪を作らない
    });
  }, []);

  // 毎レンダー後に測る（依存配列を置かない）。行の増減・開閉・リネームで位置が動くので、
  // 「何が変わったら測り直すか」を列挙するより、測って同じなら何もしない方が確実。
  useLayoutEffect(() => {
    measureRails();
  });

  // ウインドウを縮めた／行が伸びた等、レンダーを伴わない高さ変化にも追従する。
  useEffect(() => {
    const root = layerTreeRef.current;
    if (!root) return;
    const ro = new ResizeObserver(() => measureRails());
    ro.observe(root);
    return () => ro.disconnect();
  }, [measureRails]);

  // リサイズで現在サイズが変わったら数値入力欄も追従させる（入力中の値は width が変わらない限り保持）。
  useEffect(() => {
    setWDraft(String(width));
    setHDraft(String(height));
  }, [width, height]);

  // Ctrl/⌘+ホイール=カーソル基準ズーム / 通常ホイール=パン（translate）。
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomToAnchor(zoomRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
      } else {
        // 命令的に pan（再レンダーを挟まない）。入力が止んだら endPanGesture で state へ確定する。
        panGestureRef.current = true;
        const p = panRef.current;
        applyPan(clampPan({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
        if (wheelPanTimerRef.current !== null) clearTimeout(wheelPanTimerRef.current);
        wheelPanTimerRef.current = window.setTimeout(endPanGesture, 120);
      }
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  const getPoint = (e: ReactPointerEvent): StrokePoint => {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (c.width / rect.width);
    const y = (e.clientY - rect.top) * (c.height / rect.height);
    const pressure = e.pointerType === 'mouse' ? 1 : e.pressure > 0 ? e.pressure : 0.5;
    return { x, y, pressure };
  };

  // 速い動きでは、ブラウザは複数の物理サンプルを1回の pointermove にまとめて(coalesce)配信する。
  // getCoalescedEvents() で間引かれた中間サンプルまで取り出すと、粗い点を直線で結んだ多角形ではなく
  // 実際の軌跡に沿った滑らかな線になる。返す点は「実入力サンプルそのもの」を順序通り記録するだけなので、
  // rasterizeStroke の逐次区間補間・consolidate・replay のビット一致には影響しない（点が増えるだけ）。
  const getCoalescedPoints = (e: ReactPointerEvent): StrokePoint[] => {
    const native = e.nativeEvent;
    const evs = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    if (evs.length === 0) return [getPoint(e)];
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect(); // 矩形取得は1イベント1回だけ（点ごとには引かない）
    const sx = c.width / rect.width;
    const sy = c.height / rect.height;
    return evs.map((ev) => ({
      x: (ev.clientX - rect.left) * sx,
      y: (ev.clientY - rect.top) * sy,
      pressure: ev.pointerType === 'mouse' ? 1 : ev.pressure > 0 ? ev.pressure : 0.5,
    }));
  };

  const sizeCanvas = (ref: MutableRefObject<HTMLCanvasElement | null>): HTMLCanvasElement => {
    let s = ref.current;
    if (!s) {
      s = document.createElement('canvas');
      ref.current = s;
    }
    if (s.width !== width || s.height !== height) {
      s.width = width;
      s.height = height;
    }
    return s;
  };

  const ensureSnapshot = (): HTMLCanvasElement => sizeCanvas(snapshotRef);

  // ストロークプレビュー。確定時とまったく同じ op を session.state に適用した結果を合成する
  // （applyOperation は純関数なので元状態は不変）。これにより:
  //   - 消しゴムは「アクティブレイヤーだけ」を消す（他レイヤーの線が消えて見える不具合の修正）
  //   - レイヤー順（上のレイヤーが手前）も正しく反映
  //   - プレビューと確定結果がピクセル一致し、手を離した瞬間に変化しない
  const renderStrokePreview = (strokes: StrokePoint[]) => {
    const c = canvasRef.current;
    if (!c) return;
    if (strokes.length === 0) {
      compositeToCanvas(c, displayState());
      return;
    }
    compositeToCanvas(c, applyOperation(session.state, strokeOp(strokes)));
  };

  /**
   * 一筆ぶんの操作を作る。透明色（または消しゴムツール）なら eraser、それ以外は brush。
   * プレビューと確定で必ず同じ op を作るため、ここ 1 か所に集約する。
   */
  const strokeOp = (strokes: StrokePoint[]): Operation =>
    erasing
      ? createEraserOp(activeLayerId, strokes, { size, opacity, ...eraserTexture() }, width, height)
      : createBrushOp(
          activeLayerId,
          strokes,
          { color: hexToRgb(color), size, opacity, brushType, brush: brushSet },
          width,
          height,
        );

  // ---- 選択範囲オーバーレイ（マーチングアンツ）と投げ縄のプレビュー ----------------
  // 絵の canvas とは別の重ね canvas に描く。点線を動かしても・投げ縄をドラッグしても
  // レイヤー合成をやり直さずに済むので、4K でも軽い。

  /** 現在の選択マスクの輪郭ループ（マスク参照が変わったときだけ再計算）。 */
  const selectionOutline = (): number[][] => {
    const sel = session.state.selection ?? null;
    const cached = outlineCacheRef.current;
    if (cached && cached.sel === sel) return cached.loops;
    const loops = sel ? traceSelectionOutline(sel) : [];
    outlineCacheRef.current = { sel, loops };
    return loops;
  };

  const drawOverlay = () => {
    const c = selCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const z = zoomRef.current || 1;
    const dash = antsDash(z);

    // 確定済みの選択範囲＝マーチングアンツ（流れる点線）。描き方は marchingAnts.ts に集約。
    drawMarchingAnts(ctx, {
      loops: selectionOutline(),
      zoom: z,
      phase: antsPhaseRef.current,
      width,
      height,
    });

    // ドラッグ中の投げ縄。塗りのときは確定後の範囲が分かるよう内側を薄く塗って見せる。
    const la = lassoRef.current;
    if (la && la.pts.length >= 4) {
      const p = new Path2D();
      p.moveTo(la.pts[0], la.pts[1]);
      for (let i = 2; i < la.pts.length; i += 2) p.lineTo(la.pts[i], la.pts[i + 1]);
      p.closePath();
      if (la.kind === 'fill') {
        // 透明色のときは「色が乗る」わけではないので、白の薄がけで抜ける範囲だけ示す。
        ctx.fillStyle = transparentInk ? '#ffffff' : color;
        ctx.globalAlpha = (transparentInk ? 0.22 : 0.35) * opacity;
        ctx.fill(p);
        ctx.globalAlpha = 1;
      }
      // 拡大時に線が 1 キャンバス画素を割ってぼやけないよう、アンツと同じ下限を掛ける。
      ctx.lineWidth = Math.max(1, 1.5 / z);
      ctx.setLineDash([dash, dash * 0.75]);
      ctx.strokeStyle = la.kind === 'fill' ? (transparentInk ? '#ffffff' : color) : '#56ccf2';
      ctx.stroke(p);
      ctx.setLineDash([]);
    }
  };

  // 選択の変化・ズーム・キャンバスサイズ変更でオーバーレイを描き直す
  // （canvas の width/height を変えると中身が消えるので、サイズ変更後も描き直しが要る）。
  useEffect(() => {
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMask, zoom, width, height]);

  // 点線を流す。選択が無いときは止める（無駄な描画をしない）。
  // 1 ティックで破線 1 本ぶんの 1/ANTS_STEPS だけ進み、2×ANTS_STEPS ティックで元の見た目に戻る。
  useEffect(() => {
    if (!selectionMask) return;
    const t = window.setInterval(() => {
      antsPhaseRef.current = (antsPhaseRef.current + 1) % (ANTS_STEPS * 2);
      drawOverlay();
    }, 70);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMask]);

  /** 修飾キー → 既存選択との合成方法（Photoshop 等と同じ割り当て）。 */
  const selectionModeOf = (e: { shiftKey: boolean; altKey: boolean }): SelectionMode =>
    e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace';

  /** 投げ縄に点を足す（一定距離動いていなければ捨てて多角形の辺数を抑える）。 */
  const pushLassoPoint = (x: number, y: number) => {
    const la = lassoRef.current;
    if (!la) return;
    const n = la.pts.length;
    const dx = x - la.pts[n - 2];
    const dy = y - la.pts[n - 1];
    if (dx * dx + dy * dy < LASSO_MIN_STEP * LASSO_MIN_STEP) return;
    la.pts.push(x, y);
  };

  /** 投げ縄ジェスチャの確定。選択なら setSelection、塗りなら lassoFill を 1 op 積む。 */
  const commitLasso = () => {
    const la = lassoRef.current;
    lassoRef.current = null;
    if (!la) {
      drawOverlay();
      return;
    }
    if (la.pts.length < 6) {
      drawOverlay(); // 3点未満は面にならない（誤クリック）。プレビューを消すだけ。
      return;
    }
    if (la.kind === 'select') {
      // 画素は変わらないので再描画は要らない。dirty を空同然にして全面 flatten を避ける
      // （version 効果は必ず何か描き直すので、最小の矩形を渡してオーバーレイだけ更新させる）。
      markDirty({ x: 0, y: 0, w: 0, h: 0 });
      session.apply(createSetSelectionOp(la.pts, la.mode, session.state, width, height));
    } else {
      const op = createLassoFillOp(
        activeLayerId,
        la.pts,
        {
          color: transparentInk ? [0, 0, 0] : hexToRgb(color),
          opacity,
          erase: transparentInk, // 透明色の投げ縄塗り = 囲った内側を消す
        },
        width,
        height,
      );
      markDirty(op.region);
      session.apply(op);
    }
    onEdit();
    drawOverlay();
  };

  /** 選択を解除する（1 op としてログに積むので Undo で戻せる）。 */
  const clearSelection = () => {
    if (!session.state.selection) return;
    markDirty({ x: 0, y: 0, w: 0, h: 0 });
    session.apply(createClearSelectionOp(width, height));
    onEdit();
  };

  const getActiveLayer = (): Layer | undefined => getLayer(session.state, activeLayerId);

  // スポイト: 合成結果から1画素を読み、色に設定（操作はログしない読み取り専用）。
  // 合成画像から1ピクセルの色を hex で取り出す（副作用なし）。スポイト各種で共用。
  const hexAt = (flat: ImageBuffer, x: number, y: number): string | null => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= flat.width || yi >= flat.height) return null;
    const i = (yi * flat.width + xi) * 4;
    const h = (v: number) => v.toString(16).padStart(2, '0');
    return `#${h(flat.data[i])}${h(flat.data[i + 1])}${h(flat.data[i + 2])}`;
  };

  const pickColor = (x: number, y: number) => {
    const hex = hexAt(flattenState(session.state), x, y);
    if (!hex) return;
    setColor(hex);
    setTool(lastPaintToolRef.current); // 採取後は直前に使っていた筆へ戻る（鉛筆で拾って鉛筆で描ける）
  };

  // 右ボタン長押し中の一時スポイト。押下時の合成画像を1枚控え、移動でライブ採取、離した位置で確定する。
  // （ツールは切り替えない一時オーバーライド。長押し中だけ有効。）
  const rightPickRef = useRef<ImageBuffer | null>(null);

  // 塗りつぶし: 影響領域を先に算出して region に渡し、fill 操作を適用する。
  // 透明色のときは同じ領域のアルファを削る（＝連結領域を透明にする）。
  const doFill = (x: number, y: number) => {
    const region = fillRegion(session.state, activeLayerId, x, y, tolerance);
    if (region.w <= 0 || region.h <= 0) return; // 種点がレイヤ外 → 何もしない（空opを残さない）
    markDirty(region);
    session.apply(
      createFillOp(
        activeLayerId,
        transparentInk ? [0, 0, 0] : hexToRgb(color),
        opacity,
        x,
        y,
        tolerance,
        region,
        width,
        height,
        transparentInk,
      ),
    );
    onEdit();
  };

  // 直線/矩形ツールの点列。ブラシのラスタライザが点間を補間するのでブラシ操作で再現できる。
  const shapeStrokes = (sx: number, sy: number, ex: number, ey: number): StrokePoint[] => {
    if (tool === 'line') {
      return [
        { x: sx, y: sy, pressure: 1 },
        { x: ex, y: ey, pressure: 1 },
      ];
    }
    // rect（外周）: 4隅を一周
    return [
      { x: sx, y: sy, pressure: 1 },
      { x: ex, y: sy, pressure: 1 },
      { x: ex, y: ey, pressure: 1 },
      { x: sx, y: ey, pressure: 1 },
      { x: sx, y: sy, pressure: 1 },
    ];
  };

  // Transform の当たり判定: 頂点付近=拡大縮小 / 辺上=回転 / 枠内=移動（しきい値はスクリーンpx基準）。
  const hitTransform = (x: number, y: number, bb: BBox): XformHit | null => {
    const cs = bboxCorners(bb);
    const cr = XF_CORNER_PX / zoom;
    for (let i = 0; i < 4; i++) {
      if (Math.hypot(x - cs[i][0], y - cs[i][1]) <= cr) return { mode: 'scale', corner: i };
    }
    const er = XF_EDGE_PX / zoom;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = cs[i];
      const [bx, by] = cs[(i + 1) % 4];
      if (segDist(x, y, ax, ay, bx, by) <= er) return { mode: 'rotate' };
    }
    if (x >= bb.x && x <= bb.x + bb.w && y >= bb.y && y <= bb.y + bb.h) return { mode: 'move' };
    return null;
  };

  const xformCursor = (hit: XformHit | null): string => {
    if (!hit) return 'default';
    if (hit.mode === 'move') return 'move';
    if (hit.mode === 'rotate') return 'grab';
    return hit.corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize';
  };

  // ImageBuffer を実寸のオフスクリーン canvas に焼く（drawImage で GPU 変形できるように）。
  const rasterizeBuffer = (buf: ImageBuffer): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.width = buf.width;
    cv.height = buf.height;
    const cx = cv.getContext('2d')!;
    const img = cx.createImageData(buf.width, buf.height);
    img.data.set(buf.data);
    cx.putImageData(img, 0, 0);
    return cv;
  };

  // ドラッグ中の高速プレビュー用キャッシュ。アクティブレイヤーがルート直下の可視リーフのとき、
  // 「下地(アクティブより下＋背景)」「上層(アクティブより上・透明背景)」「本体」を1度だけ焼く。
  // 以後はフレーム毎に setTransform + drawImage（GPU）で重ねるだけなので再サンプル/全合成が要らない。
  const xformPreviewRef = useRef<{
    below: HTMLCanvasElement;
    above: HTMLCanvasElement;
    active: HTMLCanvasElement;
    offsetX: number;
    offsetY: number;
    opacity: number;
  } | null>(null);

  const buildXformPreview = (): void => {
    xformPreviewRef.current = null;
    const layers = session.state.layers;
    const k = layers.findIndex((n) => n.id === activeLayerId);
    if (k < 0) return;
    const node = layers[k];
    if (isGroup(node) || !node.visible) return; // グループ内/非表示は決定的フォールバックに任せる
    // クリッピングに絡む場合は決定的フォールバックに任せる（below/above 分割でクリップが崩れるため）。
    const aboveNode = layers[k + 1];
    if (node.clipped || (aboveNode && !isGroup(aboveNode) && aboveNode.clipped)) return;
    xformPreviewRef.current = {
      below: rasterizeBuffer(flattenState({ ...session.state, layers: layers.slice(0, k) })),
      above: rasterizeBuffer(
        flattenState({ ...session.state, layers: layers.slice(k + 1) }, { background: [0, 0, 0, 0] }),
      ),
      active: rasterizeBuffer(node.buffer),
      offsetX: node.offsetX,
      offsetY: node.offsetY,
      opacity: node.opacity,
    };
  };

  // Transform ドラッグ中のプレビュー。可能なら GPU(drawImage)経路、無理ならフレーム毎の決定的経路。
  // rAF で1フレーム1回に間引く。確定結果は pointer up 時に決定的再サンプルし直す。
  const renderXformPreview = () => {
    const g = xformRef.current;
    const c = canvasRef.current;
    if (!g || !c) return;
    // 有効行列（move は平行移動）。
    const m: TransformParams =
      g.mode === 'move'
        ? { a: 1, b: 0, c: 0, d: 1, e: g.dx, f: g.dy }
        : (g.matrix ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const quad = bboxCorners(g.bbox).map(
      ([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f] as [number, number],
    );

    const pv = xformPreviewRef.current;
    if (pv) {
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(pv.below, 0, 0);
      ctx.save();
      ctx.globalAlpha = pv.opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // setTransform(a,b,c,d,e,f) は (x,y)→(a*x+c*y+e, b*x+d*y+f)。TransformParams と一致。
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.drawImage(pv.active, pv.offsetX, pv.offsetY);
      ctx.restore(); // transform/alpha を identity に戻す
      ctx.drawImage(pv.above, 0, 0);
      drawXformBox(c, quad);
      return;
    }

    // フォールバック（グループ内/非表示レイヤー）: 決定的経路（重いが正確）。
    if (g.mode === 'move') {
      const preview = updateNode(session.state, activeLayerId, (n) =>
        isGroup(n) ? n : { ...n, offsetX: n.offsetX + g.dx, offsetY: n.offsetY + g.dy },
      );
      compositeToCanvas(c, preview);
      drawXformBox(c, quad);
      return;
    }
    const layer = getActiveLayer();
    if (!layer || nearIdentity(m)) {
      compositeToCanvas(c, session.state);
      drawXformBox(c, quad);
      return;
    }
    compositeToCanvas(
      c,
      applyOperation(session.state, createTransformOp(activeLayerId, m, width, height, transformedRegion(layer, m))),
    );
    drawXformBox(c, quad);
  };

  const scheduleXformPreview = () => {
    if (xformRafRef.current !== null) return;
    xformRafRef.current = requestAnimationFrame(() => {
      xformRafRef.current = null;
      renderXformPreview();
    });
  };

  // ---- ブラシ/消しゴムのドラッグ中プレビュー（増分ラスタライズ） ----
  // 旧実装は pointer move 毎に「ストローク全点を最初から再ラスタライズ＋全レイヤ全面合成」していたため、
  // 線が伸びるほど 1フレームが重くなった（O(n^2) + 毎フレーム全面合成）。透明レイヤーへ長い陰影線を
  // 何度も往復させる使い方で特に顕著だった。
  // ここでは Transform の高速プレビュー(buildXformPreview/renderXformPreview)と同じく、下地/上層を
  // down 時に1回だけ焼き、アクティブレイヤの作業バッファ(キャンバス座標)へ「新しい区間のダブだけ」を
  // 増分スタンプする。毎フレームのコストはストローク長に依存せず一定になる。
  // 確定結果は pointer up 時に従来どおり決定的に再計算する（プレビューの微小な合成誤差はそこで解消）。
  const brushPreviewRef = useRef<{
    below: HTMLCanvasElement; // アクティブより下＋背景（不透明, 1回焼き）
    above: HTMLCanvasElement; // アクティブより上（透明背景, 1回焼き）
    activeBuf: ImageBuffer; // アクティブレイヤ内容＋描画中ストローク（キャンバス座標, full-canvas）
    activeCanvas: HTMLCanvasElement; // activeBuf を putImageData で反映する 2D canvas
    activeImage: ImageData; // activeBuf.data をラップ（dirty 矩形 putImageData で再利用）
    opacity: number; // アクティブレイヤの不透明度（合成時に globalAlpha で適用）
    radius: number;
    stamp: StampFn; // ブラシ=blend / 消しゴム=erase。strokeOpacity を内包。
    profile: BrushProfile; // 筆の質感（dab の置き方）。確定時の op と必ず同じものを使う。
    last: StrokePoint | null; // 直前にスタンプした点（次区間の起点）
    primed: boolean; // 一度でも全面合成したか（初回のみ全面、以後は dirty 矩形だけ再合成）。
    dirty: { minX: number; minY: number; maxX: number; maxY: number } | null; // 前回描画以降に変化した矩形。
  } | null>(null);
  const brushRafRef = useRef<number | null>(null);
  // ストローク作業用の canvas/ImageData を使い回すキャッシュ（stroke ごとの 4K≈67MB 確保＋GC を避ける）。
  const brushActiveRef = useRef<{ canvas: HTMLCanvasElement; image: ImageData; w: number; h: number } | null>(
    null,
  );

  // below/above（アクティブ層の下地・上層）の合成キャッシュ。連続して同じレイヤに短いストロークを
  // 何本も引く間、アクティブ以外のレイヤ構成は変わらない（state は不変なので、非アクティブな最上位
  // ノードは中身が変わらない限り参照が同一に保たれる＝構造共有）。そこで「非アクティブ最上位ノードの
  // 参照列 ＋ アクティブ id ＋ キャンバスサイズ」を鍵にキャッシュし、合致すればジェスチャ境界の
  // 主コストだった全画面 flatten 2 回（下地・上層）をまるごと省く（多レイヤで ~12ms/ジェスチャ）。
  // プレビュー専用キャッシュなので replay/サムネイルのピクセル一致には一切影響しない。
  const belowAboveCacheRef = useRef<{
    activeId: string;
    w: number;
    h: number;
    belowRefs: LayerNode[];
    aboveRefs: LayerNode[];
    below: HTMLCanvasElement;
    above: HTMLCanvasElement;
  } | null>(null);

  const sameRefs = (a: LayerNode[], b: LayerNode[]): boolean =>
    a.length === b.length && a.every((n, i) => n === b[i]);

  // アクティブ層 k を境に下地(below)・上層(above)の焼き込み canvas を返す。非アクティブ層の構成が
  // 前回と参照レベルで同一ならキャッシュを再利用する（= 同じレイヤへ続けて描く間は再 flatten しない）。
  const getBelowAbove = (
    layers: LayerNode[],
    k: number,
  ): { below: HTMLCanvasElement; above: HTMLCanvasElement } => {
    const belowRefs = layers.slice(0, k);
    const aboveRefs = layers.slice(k + 1);
    const c = belowAboveCacheRef.current;
    if (
      c &&
      c.activeId === activeLayerId &&
      c.w === width &&
      c.h === height &&
      sameRefs(c.belowRefs, belowRefs) &&
      sameRefs(c.aboveRefs, aboveRefs)
    ) {
      return { below: c.below, above: c.above };
    }
    const below = rasterizeBuffer(flattenState({ ...session.state, layers: belowRefs }));
    const above = rasterizeBuffer(
      flattenState({ ...session.state, layers: aboveRefs }, { background: [0, 0, 0, 0] }),
    );
    belowAboveCacheRef.current = {
      activeId: activeLayerId,
      w: width,
      h: height,
      belowRefs,
      aboveRefs,
      below,
      above,
    };
    return { below, above };
  };

  // ドラッグ開始時に1回だけ呼ぶ。ルート直下の可視リーフのときだけ増分プレビューを構築する
  // （グループ内/非表示は false を返し、呼び出し側が従来の決定的プレビューにフォールバック）。
  const buildBrushPreview = (firstPt: StrokePoint): boolean => {
    brushPreviewRef.current = null;
    const layers = session.state.layers;
    const k = layers.findIndex((n) => n.id === activeLayerId);
    if (k < 0) return false;
    const node = layers[k];
    if (isGroup(node) || !node.visible) return false;
    // クリッピングに絡む場合、below/above のスライスがクリップ関係を分断してプレビューがずれる。
    // その時は増分プレビューを諦め、決定的経路（renderStrokePreview）に委ねる。
    const aboveNode = layers[k + 1];
    if (node.clipped || (aboveNode && !isGroup(aboveNode) && aboveNode.clipped)) return false;
    // 作業バッファは activeCanvas の ImageData と同一の Uint8ClampedArray を共有させる。これにより
    // 増分スタンプの結果を putImageData の dirty 矩形でそのまま activeCanvas へ反映できる。
    // canvas/ImageData はストローク間で使い回す（毎回 4K≈67MB の確保＋GC がストローク開始の引っかかりの主因）。
    let cache = brushActiveRef.current;
    if (!cache || cache.w !== width || cache.h !== height) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const cctx = canvas.getContext('2d');
      if (!cctx) return false;
      cache = { canvas, image: cctx.createImageData(width, height), w: width, h: height };
      brushActiveRef.current = cache;
    }
    const activeCanvas = cache.canvas;
    const actx = activeCanvas.getContext('2d');
    if (!actx) return false;
    const activeImage = cache.image;
    activeImage.data.fill(0); // 前ストロークの内容を消す（再利用なので透明へ初期化）
    const activeBuf: ImageBuffer = { width, height, data: activeImage.data };
    // アクティブレイヤ内容をキャンバス座標へ展開（offset 適用, 範囲外は捨てる）。レイヤ不透明度は
    // 合成時に globalAlpha で掛けるため、ここでは opacity:1 で焼く。
    compositeLayer(activeBuf, { ...node, opacity: 1 });
    actx.putImageData(activeImage, 0, 0);
    const op = opacity;
    // プレビューと確定描画で「同じ StampFn・同じプロファイル」を使う（別々に組むとズレる）。
    const set = tool === 'eraser' ? BRUSH_DEFAULTS.pen : brushSet;
    // 作業バッファはキャンバス座標そのもの（offset 0,0）なので、選択マスクもその座標で掛ける。
    // 確定描画（op の apply）と同じ maskStamp を通すので、選択の縁までプレビューと一致する。
    // 透明色のときは同じ質感のまま消す側（createEraseStamp）へ切り替える。
    const stamp: StampFn = maskStamp(
      erasing
        ? createEraseStamp(op, set, PAPER_SEED)
        : createBrushStamp(hexToRgb(color), op, set, PAPER_SEED),
      session.state.selection,
      0,
      0,
    );
    const profile = resolveProfile(set);
    const { below, above } = getBelowAbove(layers, k);
    brushPreviewRef.current = {
      below,
      above,
      activeBuf,
      activeCanvas,
      activeImage,
      opacity: node.opacity,
      radius: size / 2,
      stamp,
      profile,
      last: null,
      primed: false,
      dirty: null,
    };
    advanceBrush(firstPt); // 先頭点を1回スタンプ
    return true;
  };

  // 新しい点 pt を作業バッファへ増分スタンプし、影響した矩形だけ activeCanvas へ反映する。
  const advanceBrush = (pt: StrokePoint) => {
    const pv = brushPreviewRef.current;
    if (!pv) return;
    if (pv.last === null) {
      stampDab(pv.activeBuf, pt, pv.radius, 0, 0, pv.stamp, pv.profile);
      flushBrushDirty(pv, pt, pt);
    } else {
      rasterizeSegment(pv.activeBuf, pv.last, pt, pv.radius, 0, 0, pv.stamp, pv.profile);
      flushBrushDirty(pv, pv.last, pt);
    }
    pv.last = pt;
  };

  // 区間 [a,b] の影響矩形（半径＋AA分パディング, キャンバスにクランプ）だけ putImageData で反映。
  const flushBrushDirty = (
    pv: NonNullable<typeof brushPreviewRef.current>,
    a: StrokePoint,
    b: StrokePoint,
  ) => {
    const pad = Math.ceil(pv.radius) + 2;
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad));
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad));
    const maxX = Math.min(width, Math.ceil(Math.max(a.x, b.x) + pad));
    const maxY = Math.min(height, Math.ceil(Math.max(a.y, b.y) + pad));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w <= 0 || h <= 0) return;
    const actx = pv.activeCanvas.getContext('2d');
    if (actx) actx.putImageData(pv.activeImage, 0, 0, minX, minY, w, h);
    // フレーム再合成を「変化した矩形」に限定するため、前回描画以降の dirty 矩形を積算する。
    if (pv.dirty) {
      pv.dirty.minX = Math.min(pv.dirty.minX, minX);
      pv.dirty.minY = Math.min(pv.dirty.minY, minY);
      pv.dirty.maxX = Math.max(pv.dirty.maxX, maxX);
      pv.dirty.maxY = Math.max(pv.dirty.maxY, maxY);
    } else {
      pv.dirty = { minX, minY, maxX, maxY };
    }
  };

  // 下地→アクティブ(レイヤ不透明度)→上層 を GPU drawImage で重ねるだけ（全合成しない）。
  // 4K 以上では全面 clearRect + 3枚 drawImage を毎フレーム走らせるとブラシが引っかかるため、初回だけ
  // 全面合成し、以後は「変化した矩形(dirty)」だけを clip して合成し直す（下地/上層は不変、アクティブも
  // 変わったのは dirty 内だけ）。1フレームのコストがキャンバスサイズではなく描いた量に比例する。
  const renderBrushPreview = () => {
    const pv = brushPreviewRef.current;
    const c = canvasRef.current;
    if (!pv || !c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const compositeRect = (rx: number, ry: number, rw: number, rh: number) => {
      ctx.clearRect(rx, ry, rw, rh);
      ctx.drawImage(pv.below, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.save();
      ctx.globalAlpha = pv.opacity;
      ctx.drawImage(pv.activeCanvas, rx, ry, rw, rh, rx, ry, rw, rh);
      ctx.restore();
      ctx.drawImage(pv.above, rx, ry, rw, rh, rx, ry, rw, rh);
    };

    if (!pv.primed) {
      compositeRect(0, 0, c.width, c.height); // 初回は全面（下地/上層/本体をキャンバス全体に確立）
      pv.primed = true;
    } else if (pv.dirty) {
      const rx = Math.max(0, pv.dirty.minX);
      const ry = Math.max(0, pv.dirty.minY);
      const rw = Math.min(c.width, pv.dirty.maxX) - rx;
      const rh = Math.min(c.height, pv.dirty.maxY) - ry;
      if (rw > 0 && rh > 0) compositeRect(rx, ry, rw, rh);
    }
    pv.dirty = null; // 反映済み。次フレームぶんを新たに積算する。
  };

  const scheduleBrushPreview = () => {
    if (brushRafRef.current !== null) return;
    brushRafRef.current = requestAnimationFrame(() => {
      brushRafRef.current = null;
      renderBrushPreview();
    });
  };

  const teardownBrushPreview = () => {
    brushPreviewRef.current = null;
    if (brushRafRef.current !== null) {
      cancelAnimationFrame(brushRafRef.current);
      brushRafRef.current = null;
    }
  };

  /**
   * pointer の捕捉。捕捉できなくても処理は続けられるので、例外で呼び出し元を止めない。
   * setPointerCapture は「その pointerId がもう有効でない」ときに例外を投げる仕様で、
   * 素で呼ぶと pointerdown ハンドラ全体が中断され、ストロークが黙って消えることがある。
   */
  const capturePointer = (el: Element | null | undefined, pointerId: number) => {
    try {
      el?.setPointerCapture?.(pointerId);
    } catch {
      /* 捕捉できなくても、以後のイベントは要素に届く前提で続行する */
    }
  };

  // 盤面のどこからでも視点操作（パン/ズーム）を開始できるよう、viewport でも pointerdown を受ける。
  // 生キャンバス上は canvas 側 onPointerDown が処理するのでスキップ（二重発火防止）。ポインタ捕捉は
  // canvas に張り、以後の move/up は既存の canvas ハンドラ（panningRef/zoomDragRef 分岐）がそのまま処理する。
  const onViewportPointerDown = (e: ReactPointerEvent) => {
    if (e.target === canvasRef.current) return;
    const startPan = () => {
      e.preventDefault();
      panningRef.current = { x: e.clientX, y: e.clientY, left: panRef.current.x, top: panRef.current.y };
      capturePointer(canvasRef.current, e.pointerId);
    };
    if (e.button === 1 || spaceHeld) return startPan();
    if (zoomKey) {
      e.preventDefault();
      zoomDragRef.current = { startY: e.clientY, startZoom: zoomRef.current, anchorX: e.clientX, anchorY: e.clientY };
      capturePointer(canvasRef.current, e.pointerId);
    }
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (rightPickRef.current) return; // スポイト中は他の操作を始めない
    // 中ボタンドラッグ = パン（ツール・キャンバスが収まっているかに関係なく視点移動）。
    if (e.button === 1) {
      e.preventDefault();
      panningRef.current = { x: e.clientX, y: e.clientY, left: panRef.current.x, top: panRef.current.y };
      capturePointer(canvasRef.current, e.pointerId);
      return;
    }
    // Space 長押し（視点移動モード）: ドラッグでパン（描画せず視点だけ動かす）。
    if (spaceHeld) {
      e.preventDefault();
      panningRef.current = { x: e.clientX, y: e.clientY, left: panRef.current.x, top: panRef.current.y };
      capturePointer(canvasRef.current, e.pointerId);
      return;
    }
    // Z 押下中（ズームモード）: 押下位置をカーソル基準に、上下ドラッグで拡大/縮小。
    if (zoomKey) {
      e.preventDefault();
      zoomDragRef.current = { startY: e.clientY, startZoom: zoomRef.current, anchorX: e.clientX, anchorY: e.clientY };
      capturePointer(canvasRef.current, e.pointerId);
      return;
    }
    // 右ボタン長押し = 一時スポイト。押下時の合成画像を控え、移動でライブ採取、離した位置で確定。
    if (e.button === 2) {
      e.preventDefault();
      const c = canvasRef.current!;
      capturePointer(c, e.pointerId);
      const flat = flattenState(session.state);
      rightPickRef.current = flat;
      const pt = getPoint(e);
      const hex = hexAt(flat, pt.x, pt.y);
      if (hex) setColor(hex);
      c.style.cursor = 'crosshair';
      return;
    }
    const c = canvasRef.current!;
    capturePointer(c, e.pointerId);
    const pt = getPoint(e);
    // S 押下中（太さ調整モード）: 押下位置にリングを固定し、上下ドラッグで太さを変える。
    // 太さを持つツール（ブラシ/消しゴム/直線/矩形 = showCursor）のときだけ有効。
    if (sizeAdjust && showCursor) {
      sizeDragRef.current = { startY: e.clientY, startSize: size };
      moveCursor(e.clientX, e.clientY); // リングを押下位置へ固定（以後は追従させない）
      return;
    }
    if (tool === 'eyedropper') {
      pickColor(pt.x, pt.y);
    } else if (tool === 'bucket') {
      doFill(pt.x, pt.y);
    } else if (tool === 'transform') {
      const bb = activeContentBBox;
      if (!bb) return;
      const hit = hitTransform(pt.x, pt.y, bb);
      if (!hit) return;
      if (hit.mode === 'move') {
        xformRef.current = { mode: 'move', startX: pt.x, startY: pt.y, bbox: bb, dx: 0, dy: 0 };
      } else if (hit.mode === 'scale') {
        const cs = bboxCorners(bb);
        const [gx, gy] = cs[hit.corner];
        const [fx, fy] = cs[(hit.corner + 2) % 4]; // 対角の頂点を固定点にする
        xformRef.current = {
          mode: 'scale',
          corner: { x: gx, y: gy },
          fixed: { x: fx, y: fy },
          bbox: bb,
          matrix: null,
        };
      } else {
        const pivot = { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
        xformRef.current = {
          mode: 'rotate',
          pivot,
          startAngle: Math.atan2(pt.y - pivot.y, pt.x - pivot.x),
          bbox: bb,
          matrix: null,
        };
      }
      buildXformPreview(); // ドラッグ中の高速プレビュー用に下地/上層/本体を1度だけ焼く
      c.style.cursor = hit.mode === 'rotate' ? 'grabbing' : xformCursor(hit);
    } else if (tool === 'lassoSelect' || tool === 'lassoFill') {
      lassoRef.current = {
        pts: [pt.x, pt.y],
        kind: tool === 'lassoFill' ? 'fill' : 'select',
        mode: selectionModeOf(e), // Shift=追加 / Alt=削除 / Shift+Alt=交差（押下時の修飾で決める）
      };
      drawOverlay();
    } else if (tool === 'line' || tool === 'rect') {
      shapeRef.current = { startX: pt.x, startY: pt.y };
      const snap = ensureSnapshot();
      const sctx = snap.getContext('2d')!;
      sctx.clearRect(0, 0, width, height);
      sctx.drawImage(c, 0, 0);
    } else {
      // brush / eraser
      drawingRef.current = { strokes: [pt] };
      // 増分プレビューを構築（ルート直下の可視リーフのみ）。不可なら従来の決定的プレビュー。
      if (buildBrushPreview(pt)) renderBrushPreview();
      else renderStrokePreview(drawingRef.current.strokes);
    }
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (panningRef.current) {
      const d = panningRef.current;
      // 命令的に pan（再レンダーを挟まない）。確定は pointerup（endPanGesture）で行う。
      panGestureRef.current = true;
      applyPan(clampPan({ x: d.left + (e.clientX - d.x), y: d.top + (e.clientY - d.y) }));
      if (showCursor) moveCursor(e.clientX, e.clientY); // パン中もリングカーソルを追従させる
      return;
    }
    // 右ボタンスポイト中: 控えた合成画像からカーソル位置の色をライブ採取。
    if (rightPickRef.current) {
      const pt = getPoint(e);
      const hex = hexAt(rightPickRef.current, pt.x, pt.y);
      if (hex) setColor(hex);
      return;
    }
    // ズームドラッグ中: 上=拡大 / 下=縮小。押下時のカーソル位置を基準に保つ（zoomToAnchor）。
    if (zoomDragRef.current) {
      const d = zoomDragRef.current;
      zoomToAnchor(d.startZoom * Math.pow(1.01, d.startY - e.clientY), d.anchorX, d.anchorY);
      return;
    }
    // 太さ調整ドラッグ中: 上=太く / 下=細く。リングは押下位置に固定したまま大きさだけ変える。
    if (sizeDragRef.current) {
      const d = sizeDragRef.current;
      setSize(Math.round(d.startSize + (d.startY - e.clientY) * SIZE_DRAG_FACTOR));
      return;
    }
    if (showCursor) {
      moveCursor(e.clientX, e.clientY);
      // pointerEnter を取りこぼして hovering が false で固まっても、移動で表示を自己回復する
      // （setPointerCapture 解放時などに spurious な pointerLeave が出てカーソルが消える対策）。
      if (!hovering) setHovering(true);
    }
    // Transform ツールのホバー: 位置に応じてカーソルを変える（再レンダーを避け DOM 直接更新）。
    if (tool === 'transform' && !xformRef.current) {
      const c = canvasRef.current;
      if (c) {
        const pt = getPoint(e);
        c.style.cursor = activeContentBBox
          ? xformCursor(hitTransform(pt.x, pt.y, activeContentBBox))
          : 'default';
      }
    }
    if (drawingRef.current) {
      // 1イベントにまとまった中間サンプルを全て順序通り記録（速い線のファセット解消）。
      const pts = getCoalescedPoints(e);
      for (const pt of pts) {
        drawingRef.current.strokes.push(pt);
        if (brushPreviewRef.current) advanceBrush(pt); // 新区間だけ増分スタンプ（軽い）
      }
      if (brushPreviewRef.current) scheduleBrushPreview(); // 合成は rAF で1フレーム1回に間引く
      else renderStrokePreview(drawingRef.current.strokes);
    } else if (xformRef.current) {
      const g = xformRef.current;
      const pt = getPoint(e);
      if (g.mode === 'move') {
        g.dx = Math.round(pt.x - g.startX);
        g.dy = Math.round(pt.y - g.startY);
      } else if (g.mode === 'scale') {
        const f = g.fixed;
        if (e.shiftKey) {
          // Shift: 縦横独立（負値で反転も可）
          const sx = clampScale((pt.x - f.x) / (g.corner.x - f.x));
          const sy = clampScale((pt.y - f.y) / (g.corner.y - f.y));
          g.matrix = { a: sx, b: 0, c: 0, d: sy, e: f.x - sx * f.x, f: f.y - sy * f.y };
        } else {
          // 等比: 固定点（対角の頂点）からの距離比
          const s = clampScale(
            Math.hypot(pt.x - f.x, pt.y - f.y) / Math.hypot(g.corner.x - f.x, g.corner.y - f.y),
          );
          g.matrix = { a: s, b: 0, c: 0, d: s, e: f.x - s * f.x, f: f.y - s * f.y };
        }
      } else {
        let deg = ((Math.atan2(pt.y - g.pivot.y, pt.x - g.pivot.x) - g.startAngle) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15; // Shift: 15°刻みスナップ
        g.matrix = buildMatrix(1, deg, g.pivot);
      }
      scheduleXformPreview();
    } else if (lassoRef.current) {
      // 中間サンプルも全部拾ってから間引く（速く動かしても輪郭がカクつかない）。
      for (const pt of getCoalescedPoints(e)) pushLassoPoint(pt.x, pt.y);
      drawOverlay();
    } else if (shapeRef.current) {
      const pt = getPoint(e);
      renderStrokePreview(shapeStrokes(shapeRef.current.startX, shapeRef.current.startY, pt.x, pt.y));
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (panningRef.current) {
      panningRef.current = null;
      endPanGesture(); // 命令的に動かした最終位置を React state へ確定する
      return;
    }
    // 右ボタンスポイト確定: 離した位置の色を採取してブラシ色に。ツールは変えない。
    if (rightPickRef.current) {
      const pt = getPoint(e);
      const hex = hexAt(rightPickRef.current, pt.x, pt.y);
      if (hex) setColor(hex);
      rightPickRef.current = null;
      const c = canvasRef.current;
      if (c) c.style.cursor = '';
      return;
    }
    if (zoomDragRef.current) {
      zoomDragRef.current = null;
      return;
    }
    if (sizeDragRef.current) {
      sizeDragRef.current = null;
      return;
    }
    if (drawingRef.current) {
      const strokes = drawingRef.current.strokes;
      drawingRef.current = null;
      teardownBrushPreview(); // 増分プレビューのキャッシュ/保留rAFを破棄（以降は決定的 repaint）
      if (strokes.length > 0) {
        const op = strokeOp(strokes);
        session.apply(op);
        // 確定描画はデバウンス。プレビュー最終フレームが表示を担うので、連続ストロークでも 1 本ごとに
        // 固まらない（バーストが収まってから 90ms で 1 回だけ確定描画）。version 依存の useEffect は
        // deferExactRef を見て即時 flatten を省く。session.state は即時正しい。
        // markDirty でストロークの bbox を積んでおき、確定は全面ではなくその矩形だけ再描画する。
        markDirty(op.region);
        deferExactRef.current = true;
        scheduleExactRepaint();
        onEdit();
      } else {
        repaint(); // 何も確定していない（誤クリック等）。残ったプレビューを消すだけ。
      }
    } else if (xformRef.current) {
      const g = xformRef.current;
      xformRef.current = null;
      xformPreviewRef.current = null; // 高速プレビューのキャッシュを破棄
      if (xformRafRef.current !== null) {
        cancelAnimationFrame(xformRafRef.current);
        xformRafRef.current = null;
      }
      const layer = getActiveLayer();
      if (g.mode === 'move') {
        const pt = getPoint(e);
        const dx = Math.round(pt.x - g.startX);
        const dy = Math.round(pt.y - g.startY);
        if ((dx !== 0 || dy !== 0) && layer) {
          const region = unionBBox(g.bbox, {
            x: g.bbox.x + dx,
            y: g.bbox.y + dy,
            w: g.bbox.w,
            h: g.bbox.h,
          });
          // 移動は非破壊（translate）。変形ストリークは切る（次の回転は移動後から1回再サンプル）。
          xformStreakRef.current = null;
          xformBaseStateRef.current = null;
          markDirty(region); // 移動元＋移動先だけ部分再描画（version 効果が実行）
          session.apply(createTranslateOp(activeLayerId, dx, dy, width, height, region));
          onEdit();
        } else {
          repaint(); // 動いていない＝プレビューを消すだけ
        }
      } else if (layer && g.matrix && !nearIdentity(g.matrix)) {
        commitXformGesture(g.matrix); // 連続変形を統合（onEdit + repaint を含む）
      } else {
        repaint();
      }
    } else if (lassoRef.current) {
      const pt = getPoint(e);
      pushLassoPoint(pt.x, pt.y);
      commitLasso();
    } else if (shapeRef.current) {
      const pt = getPoint(e);
      const { startX, startY } = shapeRef.current;
      shapeRef.current = null;
      // 始点と終点が同じなら何もしない（誤クリック対策）。
      if (Math.abs(pt.x - startX) > 1 || Math.abs(pt.y - startY) > 1) {
        const op = strokeOp(shapeStrokes(startX, startY, pt.x, pt.y));
        markDirty(op.region);
        session.apply(op);
        onEdit();
      } else {
        repaint(); // 実質クリック（形状なし）: プレビューを消すだけ
      }
    }
  };

  // brightness/hue は「相対調整(delta)を1クリック=1操作」。影響範囲はレイヤ内容のbbox。
  const adjustBrightness = (delta: number) => {
    const layer = getActiveLayer();
    const region = layer ? layerContentBBox(layer) : undefined;
    if (region) markDirty(region);
    session.apply(createBrightnessOp(activeLayerId, delta, width, height, region));
    onEdit();
  };

  const adjustHue = (shift: number) => {
    const layer = getActiveLayer();
    const region = layer ? layerContentBBox(layer) : undefined;
    if (region) markDirty(region);
    session.apply(createHueOp(activeLayerId, shift, width, height, region));
    onEdit();
  };

  // ---- TRANSFORM（拡大縮小・回転・反転）。アクティブレイヤー内容を中心基準で変形する。 ----
  const pivotOf = (layer: Layer): { x: number; y: number } | null => {
    const bb = layerContentBBox(layer);
    if (bb.w <= 0 || bb.h <= 0) return null;
    return { x: bb.x + bb.w / 2, y: bb.y + bb.h / 2 };
  };

  // scale(s, 中心 pivot) と rotate(deg) を合成したキャンバス座標アフィン行列。
  const buildMatrix = (s: number, deg: number, pivot: { x: number; y: number }): TransformParams => {
    const rad = (deg * Math.PI) / 180;
    const a = Math.cos(rad) * s;
    const b = Math.sin(rad) * s;
    const c = -Math.sin(rad) * s;
    const d = Math.cos(rad) * s;
    return {
      a,
      b,
      c,
      d,
      e: pivot.x - (a * pivot.x + c * pivot.y),
      f: pivot.y - (b * pivot.x + d * pivot.y),
    };
  };

  // 変換後の内容 bbox（依存判定 region 用）。
  const transformedRegion = (layer: Layer, m: TransformParams): BBox => {
    const { offsetX: ox, offsetY: oy, buffer } = layer;
    const pts: [number, number][] = [
      [ox, oy],
      [ox + buffer.width, oy],
      [ox + buffer.width, oy + buffer.height],
      [ox, oy + buffer.height],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of pts) {
      const dx = m.a * x + m.c * y + m.e;
      const dy = m.b * x + m.d * y + m.f;
      if (dx < minX) minX = dx;
      if (dx > maxX) maxX = dx;
      if (dy < minY) minY = dy;
      if (dy > maxY) maxY = dy;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  };

  // 90°回転・反転ボタン用の単発確定（ストリークは切る）。
  const applyTransformMatrix = (m: TransformParams, layer: Layer) => {
    const after = transformedRegion(layer, m);
    markDirty(unionBBox(layerContentBBox(layer), after)); // 変形前の内容位置＋変形後をまとめて再描画
    session.apply(createTransformOp(activeLayerId, m, width, height, after));
    xformStreakRef.current = null;
    xformBaseStateRef.current = null;
    onEdit();
  };

  // Transform ツールのジェスチャ確定。m は「現在の表示内容 → 変形後」のキャンバス座標アフィン。
  // 直前の確定が同一ストリークの変形なら、行列を合成して「ストリーク開始時の状態」から
  // 1回だけ再サンプルし直し、末尾 op を置き換える（amendLast）。全ログ replay を避けるため軽い。
  // これによりバッファ肥大も再サンプル累積（解像度低下）も起きない。
  const commitXformGesture = (m: TransformParams) => {
    const log = session.getLog();
    const last = log[log.length - 1];
    const streak = xformStreakRef.current;
    const baseState = xformBaseStateRef.current;
    const baseLayer = baseState ? getLayer(baseState, activeLayerId) : undefined;
    const continues =
      !!streak && !!last && last.id === streak.opId && last.type === 'transform' &&
      last.layerId === activeLayerId && !!baseState && !!baseLayer;
    if (continues) {
      const cumulative = composeMatrix(m, streak!.cumulative);
      const after = transformedRegion(baseLayer!, cumulative);
      // 現在表示中の変形領域（前回の cumulative）＋今回の領域を再描画（間の差分を確実に覆う）。
      markDirty(unionBBox(transformedRegion(baseLayer!, streak!.cumulative), after));
      const op = createTransformOp(activeLayerId, cumulative, width, height, after);
      const newState = applyOperation(baseState!, op); // 元バッファから1回だけ再サンプル（replay 不要）
      session.amendLast(op, newState);
      xformStreakRef.current = { opId: op.id, cumulative };
    } else {
      const base = getActiveLayer();
      if (!base) {
        repaint();
        return;
      }
      const after = transformedRegion(base, m);
      markDirty(unionBBox(layerContentBBox(base), after)); // 変形前の内容位置＋変形後
      xformBaseStateRef.current = session.state; // ストリーク開始時の状態を控える（構造共有で軽量）
      const op = createTransformOp(activeLayerId, m, width, height, after);
      session.apply(op);
      xformStreakRef.current = { opId: op.id, cumulative: m };
    }
    onEdit();
  };

  const applyRotate90 = (dir: 1 | -1) => {
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    applyTransformMatrix(buildMatrix(1, dir * 90, pivot), layer);
  };

  const applyFlip = (axis: 'h' | 'v') => {
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    const a = axis === 'h' ? -1 : 1;
    const d = axis === 'v' ? -1 : 1;
    applyTransformMatrix({ a, b: 0, c: 0, d, e: pivot.x - a * pivot.x, f: pivot.y - d * pivot.y }, layer);
  };

  const addLayer = () => {
    const id = genId('layer');
    const name = `Layer ${session.state.layers.length}`;
    session.apply(createAddLayerOp(id, name, width, height));
    setActiveLayerId(id);
    onEdit();
    repaint();
  };

  // 画像を新規レイヤとして読み込む。キャンバスに収まるよう縮小し、中央に配置する。
  // 画素は addImageLayer 操作に焼き込まれ、log だけから決定的に再構築できる。
  const importImage = (file: File) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(width / img.width, height / img.height, 1);
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.drawImage(img, 0, 0, w, h);
      const px = octx.getImageData(0, 0, w, h);
      const buffer: ImageBuffer = { width: w, height: h, data: px.data };
      const id = genId('layer');
      const name = file.name.replace(/\.[^.]+$/, '') || `Image ${session.state.layers.length}`;
      const offsetX = Math.floor((width - w) / 2);
      const offsetY = Math.floor((height - h) / 2);
      session.apply(createAddImageLayerOp(id, name, buffer, offsetX, offsetY, width, height));
      setActiveLayerId(id);
      onEdit();
      repaint();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      alert('画像の読み込みに失敗しました。');
    };
    img.src = url;
  };

  // PSD を読み込み、PSD 実寸のキャンバスで新規ドキュメントとして開く（レイヤー/フォルダ/クリッピング
  // を保持）。全レイヤーは1回の Undo 単位（applyBatch）で構築され、画素は各操作へ焼き込まれるので
  // log から決定的に replay できる。実際のセッション作り直しは App 側（onLoadPsdDocument）が担う。
  const importPsd = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      // ag-psd は大きいので初回インポート時だけ動的ロード（初期表示を軽く保つ）。
      const { buildPsdImportOps } = await import('./psdImport');
      const {
        ops,
        width: w,
        height: h,
        leafCount,
        groupCount,
        clipCount,
        multiplyCount,
        droppedBlendCount,
        scaled,
        psdWidth,
        psdHeight,
      } = buildPsdImportOps(buffer, MAX_CANVAS_DIM);
      if (ops.length === 0) {
        alert('PSD に取り込めるレイヤーが見つかりませんでした。');
        return;
      }
      // 現在の内容がある場合は破棄確認（新規ドキュメントとして開くため）。
      if (
        session.getLog().length > 0 &&
        !window.confirm(
          `PSD を読み込み、キャンバスを ${w}×${h} に変更します。\n現在の内容は破棄されます。よろしいですか？`,
        )
      ) {
        return;
      }
      onLoadPsdDocument(w, h, ops);
      console.info(
        `PSD を取り込みました: ${w}×${h}（PSD 実寸 ${psdWidth}×${psdHeight}）/ ` +
          `${leafCount} レイヤー / ${groupCount} フォルダ` +
          (clipCount ? ` / クリッピング ${clipCount}` : '') +
          (multiplyCount ? ` / 乗算 ${multiplyCount}` : '') +
          (droppedBlendCount
            ? ` / 未対応のブレンドモード ${droppedBlendCount}（通常合成に倒しました）`
            : '') +
          (scaled ? '（上限を超えるため縮小）' : ''),
      );
    } catch (err) {
      console.error(err);
      alert('PSD の読み込みに失敗しました。対応していない形式の可能性があります。');
    }
  };

  // キャンバス（アートボード）サイズを変更する。非破壊: レイヤーの buffer/offset は触らず、クリップ範囲
  // （アートボード矩形）だけを canvasSize op で変える。縮小=枠外に隠れる / 拡大=再び現れる（内容は消えない）。
  // op として log に積むので Undo できる。
  const changeCanvasSize = (w: number, h: number) => {
    const cw = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.round(w)));
    const ch = Math.max(1, Math.min(MAX_CANVAS_DIM, Math.round(h)));
    if (!Number.isFinite(cw) || !Number.isFinite(ch)) return;
    if (cw === width && ch === height) return;
    markDirty('full'); // クリップ範囲が変わるので全面再描画
    session.apply(createSetCanvasSizeOp(cw, ch));
    onEdit(); // App が現在サイズ(session.state.width/height)を読み直して width/height を再伝播する
  };

  const applyCanvasSize = () => changeCanvasSize(Number(wDraft), Number(hDraft));

  // ---- 辺ドラッグでのキャンバスリサイズ（右辺=幅 / 下辺=高さ。離した時に1操作で確定） ----
  // ドラッグ中は合成し直さず、破線の枠(resizeOutlineRef)を命令的に動かすだけ（軽い）。離した位置で
  // changeCanvasSize を1回呼んで確定する。左上(0,0)固定なので中身のオフセットは変えない。
  const RESIZE_MIN = 16;
  const resizeDragRef = useRef<{ axis: 'w' | 'h'; startX: number; startY: number; startW: number; startH: number; curW: number; curH: number } | null>(
    null,
  );
  const resizeOutlineRef = useRef<HTMLDivElement>(null);

  const showResizeOutline = (w: number, h: number) => {
    const el = resizeOutlineRef.current;
    if (!el) return;
    el.style.display = 'block';
    el.style.width = `${w * zoom}px`;
    el.style.height = `${h * zoom}px`;
    el.dataset.label = `${w} × ${h}`;
  };

  const onResizeHandleDown = (axis: 'w' | 'h', e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    capturePointer(e.currentTarget as HTMLElement, e.pointerId);
    resizeDragRef.current = { axis, startX: e.clientX, startY: e.clientY, startW: width, startH: height, curW: width, curH: height };
    showResizeOutline(width, height);
  };

  const onResizeHandleMove = (e: ReactPointerEvent) => {
    const d = resizeDragRef.current;
    if (!d) return;
    const w =
      d.axis === 'w'
        ? Math.max(RESIZE_MIN, Math.min(MAX_CANVAS_DIM, Math.round(d.startW + (e.clientX - d.startX) / zoom)))
        : d.startW;
    const h =
      d.axis === 'h'
        ? Math.max(RESIZE_MIN, Math.min(MAX_CANVAS_DIM, Math.round(d.startH + (e.clientY - d.startY) / zoom)))
        : d.startH;
    d.curW = w;
    d.curH = h;
    showResizeOutline(w, h);
  };

  const onResizeHandleUp = (e: ReactPointerEvent) => {
    const d = resizeDragRef.current;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 既に解放済み */
    }
    resizeDragRef.current = null;
    if (resizeOutlineRef.current) resizeOutlineRef.current.style.display = 'none';
    changeCanvasSize(d.curW, d.curH); // 変化が無ければ内部で no-op
  };

  // 現在の合成結果を PNG として書き出す（オーバーレイなしの純粋な合成）。
  const exportPng = () => {
    const off = document.createElement('canvas');
    compositeToCanvas(off, session.state);
    off.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'image.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };

  // ノードの影響領域（リーフは内容bbox、グループは省略=空）。
  const nodeRegion = (n: LayerNode) => (isGroup(n) ? undefined : layerContentBBox(n));
  const leafCount = () => session.state.layers.flatMap(collectLeafIds).length;

  /**
   * レイヤー操作ボタンの対象を解決する。行にボタンを置かない代わりに、「どの行に効くのか」の
   * 判定はここ 1 か所に集約する。
   *
   * スロット（横軸）を選んでいるときは、いまそこに出ている差分に効かせる。行に見えているのは
   * その 1 枚なので、ボタンの効き先も同じにしないと「見えているものと違うものが変わる」ことになる。
   * stack が非 null なら、その対象は差分（＝削除は「差分を 1 枚捨てる」になる）。
   *
   * slot は「行そのもの」。中身（差分）に効く操作と、行に効く操作は別物なので分けている
   * （表示/非表示は行の性質。中身ごとの非表示は、スロットの排他性と二重になるので持たせない）。
   */
  const opTarget = (): {
    node: LayerNode;
    leaf: Layer | null;
    stack: LayerGroup | null;
    slot: LayerNode;
  } | null => {
    const raw =
      getNode(session.state, selectedId) ?? getNode(session.state, session.state.activeLayerId);
    if (!raw) return null;
    const node = isVariantStack(raw) ? (activeVariant(raw) ?? raw) : raw;
    const stack = getVariantStackOf(session.state, node.id) ?? null;
    return { node, leaf: isGroup(node) ? null : node, stack, slot: stack ?? node };
  };

  /**
   * 表示/非表示の効き先。「行ごと一時的に絵から外す」なので、スロット（行）に効かせる。
   *
   * ただし正規化前のデータ（＝スロットに入る前から非表示だったもの）では中身に非表示が
   * 残っていることがあり、行側だけを対象にすると直せなくなって詰む。中身に立っているときだけ
   * そちらを対象にして、押せば必ず「出る」方向へ収束させる。
   */
  const visibilityTarget = (t: NonNullable<ReturnType<typeof opTarget>>): LayerNode =>
    t.node.visible === false ? t.node : t.slot;

  const toggleVisibility = (n: LayerNode) => {
    session.apply(createSetLayerVisibilityOp(n.id, !n.visible, nodeRegion(n)));
    onEdit();
    repaint();
  };

  // クリッピング（下のレイヤーにクリップ）。リーフのみ。直下に兄弟（＝下地）があるとき効く。
  // 横軸（差分スタック）の中に居るときは、合成上そのスロットの位置に居るので、下地はスロットの下。
  const canClip = (n: LayerNode): boolean => {
    if (isGroup(n)) return false;
    const info = getSlotInfo(session.state, n.id);
    return !!info && info.index > 0;
  };
  const toggleClip = (n: LayerNode) => {
    if (isGroup(n)) return;
    session.apply(createSetLayerClippingOp(n.id, !n.clipped, nodeRegion(n)));
    onEdit();
    repaint();
  };

  // 合成方法（いまは 通常 ⇄ 乗算 のトグル）。リーフ・フォルダどちらにも効く。
  // フォルダに掛けると、そのフォルダの合成結果まるごとが下地に掛かる（＝影のフォルダを一括で乗算）。
  const toggleMultiply = (n: LayerNode) => {
    const next = n.blendMode === 'multiply' ? 'normal' : 'multiply';
    session.apply(createSetLayerBlendModeOp(n.id, next, nodeRegion(n)));
    onEdit();
    repaint();
  };

  const deleteLayer = (n: LayerNode) => {
    if (leafCount() - collectLeafIds(n).length < 1) return; // 最低1リーフを残す
    session.apply(createRemoveLayerOp(n.id, nodeRegion(n)));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
    repaint();
  };

  // ---- レイヤーの横軸（差分スタック） ----------------------------------------
  // 縦軸（z 順）に対して、同じスロットに互いに排他な差分を左右へ並べる。増やす対象は
  // アクティブレイヤーの居るスロット。既に横軸なら右隣へ、まだなら その場で横軸化して 2 つ目にする。
  const addVariant = (copy: boolean) => {
    const t = opTarget();
    if (!t) return;
    const target = t.node;
    const stack = t.stack;
    const count = stack ? stack.children.length : 1;
    const name = copy ? `${target.name} copy` : `Var ${count + 1}`;
    markDirty('full');
    session.apply(
      createAddVariantOp(target.id, stack?.id ?? genId('variants'), genId('layer'), name, copy),
    );
    // op は新しい差分を描き先にする。選択もそこへ移して、続けて操作できるようにする。
    setActiveLayerId(session.state.activeLayerId);
    setSelectedId(session.state.activeLayerId);
    onEdit();
  };

  /**
   * 空スロットを足す。「この行には何も無い」を、フラグではなく選べる中身にする。
   *
   * これが「非表示にして残す」の置き換え。中身ごとの非表示だと、
   *   - 出ていない差分の非表示は誰にも効かない（死んだデータ）
   *   - スライドして出した瞬間に「出したのに何も無い」になる
   * 空スロットなら、無いことが横並びの 1 枚として見え、状態の所属先にもなれる（規則4 の実体）。
   */
  const addEmptySlot = () => {
    const t = opTarget();
    if (!t) return;
    markDirty('full');
    session.apply(
      createAddVariantOp(
        t.node.id,
        t.stack?.id ?? genId('variants'),
        genId('empty'),
        '（空）',
        false,
        undefined,
        true,
      ),
    );
    // 空スロットは描き先になれない（リーフが無い）。選択だけそのスロットへ寄せる。
    setActiveLayerId(session.state.activeLayerId);
    setSelectedId(getVariantStackOf(session.state, t.node.id)?.id ?? t.node.id);
    onEdit();
  };

  // いま出ている差分を捨てる。残り 1 つになったら横軸は解け、素のレイヤーに戻る。
  const removeVariant = (stack: LayerGroup, variant: LayerNode) => {
    // 差分が 1 つしか残っていない退化スタックはスロットごと消す。
    if (stack.children.length < 2) {
      deleteLayer(stack);
      return;
    }
    if (leafCount() - collectLeafIds(variant).length < 1) return; // 最低1リーフを残す
    markDirty('full');
    session.apply(createRemoveVariantOp(stack.id, variant.id, nodeRegion(variant)));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  // レイヤーの内容を全消去（透明化）。レイヤー自体は残る。1操作として記録され Undo 可能。
  const clearLayerContent = (layer: Layer) => {
    session.apply(createClearLayerOp(layer.id, width, height, layerContentBBox(layer)));
    onEdit();
    repaint();
  };

  // 下のレイヤーと統合（merge down）。同じ親内の隣接リーフ同士のみ。
  // 横軸（差分スタック）の中の差分は対象外: 横の隣は「別の可能性」であって下ではないし、
  // スロットの下と統合すると他の差分が行き場を失う。
  const canMergeDown = (n: LayerNode): boolean => {
    if (isGroup(n)) return false;
    if (getVariantStackOf(session.state, n.id)) return false;
    const info = getParentInfo(session.state, n.id);
    if (!info || info.index <= 0) return false;
    return !isGroup(info.siblings[info.index - 1]);
  };
  const mergeDown = (n: LayerNode) => {
    if (!canMergeDown(n)) return;
    const info = getParentInfo(session.state, n.id)!;
    const lower = info.siblings[info.index - 1] as Layer;
    const region = unionBBox(layerContentBBox(n as Layer), layerContentBBox(lower));
    session.apply(createMergeDownLayerOp(n.id, region));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
    repaint();
  };

  // ---- レイヤーの D&D（並べ替え / フォルダ出し入れ）。▲▼ ボタンと 📁→ 選択の代替。 ----
  // ネイティブ HTML5 D&D はマウス専用でペン/タッチで発火しないため、pointer イベントで自作する。
  // 表示は上=最前面で逆順描画するので、視覚上の「above（上）」は配列では index 大（後ろ）になる。

  // 追従する半透明ゴーストを pointer 位置へ移動（再レンダーを避け DOM 直接更新）。
  const positionGhost = (clientX: number, clientY: number) => {
    const g = ghostRef.current;
    if (g) {
      g.style.left = `${clientX + 12}px`;
      g.style.top = `${clientY + 8}px`;
    }
  };

  const cancelLiftTimer = () => {
    if (liftTimerRef.current !== null) {
      window.clearTimeout(liftTimerRef.current);
      liftTimerRef.current = null;
    }
  };

  // 行の外で離したときの後始末。持ち上がる前は pointer を捕捉していないので、pointerup が
  // 行に届かないことがある。放っておくと「離した後に勝手に持ち上がる」ので window で拾って止める。
  useEffect(() => {
    const cancel = () => {
      if (dragIdRef.current) return; // 持ち上がった後は行側の onPointerUp が面倒を見る
      cancelLiftTimer();
      pendingDragRef.current = null;
    };
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 行を持ち上げる（＝移動ジェスチャの開始）。以後の move/up を確実に受けるため pointer を捕捉する。 */
  const liftRow = () => {
    cancelLiftTimer();
    const p = pendingDragRef.current;
    if (!p) return;
    const node = getNode(session.state, p.id);
    if (!node) {
      pendingDragRef.current = null;
      return;
    }
    dragIdRef.current = p.id;
    dragOriginRef.current = { x: p.startX, y: p.startY };
    capturePointer(p.el, p.pointerId);
    setDragGhost({ id: p.id, name: node.name });
    pendingDragRef.current = null;
  };

  // 行のどこでも掴めるように、pointerdown ではドラッグを「保留」にするだけ（クリックを壊さない）。
  // ボタン/入力欄の上では保留しない（そのコントロールのクリック/入力を優先）。
  // 保留のまま LAYER_LIFT_MS 押し続けると持ち上がり、⠿ グリップからならすぐ持ち上がる。
  const onRowPointerDown = (n: LayerNode, e: ReactPointerEvent) => {
    // 新しいジェスチャの開始。前のジェスチャの「クリックを飲む」フラグはここで必ず落とす。
    gestureConsumedRef.current = false;
    if (e.button !== 0) return; // 主ボタン（左/ペン接地）のみ
    const el = e.target as HTMLElement | null;
    if (el && el.closest('button, input, textarea, select, [contenteditable="true"]')) return;
    cancelLiftTimer();
    pendingDragRef.current = {
      id: n.id,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      el: e.currentTarget as HTMLElement,
    };
    if (el && el.closest('.layer-grip')) {
      liftRow(); // 掴む取っ手からは待たずに持ち上げる
      return;
    }
    liftTimerRef.current = window.setTimeout(liftRow, LAYER_LIFT_MS);
  };

  // ---- レイヤーの横軸（差分スタック）の切り替え ----
  // 行に差分のサムネイルを横に並べ、ホバーで「その差分が出ている絵」を仮に見せ、
  // クリックで確定する。覗き見の間は state を一切触らず displayState() で差し替えるだけなので、
  // 見比べても履歴は汚れない（確定して初めて 1 op = Undo 1 回になる）。
  const peekVariant = (stack: LayerGroup, index: number) => {
    if (dragIdRef.current) return; // 並べ替えドラッグ中に覗き見が割り込まないように
    const base = variantIndexOf(stack);
    if (index === base) {
      clearVariantPeek(); // 出ているものへ戻ってきた
      return;
    }
    const cur = variantPeekRef.current;
    if (cur && cur.stackId === stack.id && cur.index === index) return;
    variantPeekRef.current = { stackId: stack.id, index, baseIndex: base };
    setVariantPeek({ stackId: stack.id, index });
    repaint();
  };

  /**
   * カルーセルの帯の位置。baseIndex の 1 枚が中央の枠に来る位置から、指の移動量ぶんずらす。
   *
   * 向き: 掴んでいるのは「差分の帯そのもの」で、内容が指について動く（写真カルーセルと同じ）。
   * 帯を左へ引けば帯は左へ流れ、右隣の差分が中央の枠に入ってくる。
   * 中央の枠は動かない。動くのは常に中身の方。
   */
  const carouselTransform = (sw: { baseIndex: number; dx: number }) =>
    `translateX(${-sw.baseIndex * VARIANT_PITCH_PX + sw.dx}px)`;

  /**
   * スライドの現在位置を反映する。カルーセルを指に追従させ、中央の枠に来た 1 枚を覗き見する。
   * スライドを始めたその move でも呼ぶ（開始と反映を分けると、速く弾いたときに最初の移動量が
   * 捨てられて 1 段も動かないことがある）。
   */
  const updateSwipe = (clientX: number) => {
    const sw = swipeRef.current;
    if (!sw) return;
    // 端を越えて滑らないよう、動かせる範囲を先頭〜末尾に収める。
    // 帯を右へ引くほど左（前）の差分が枠に来るので、右へ引ける量は左に残っている枚数で決まる。
    const maxRight = sw.baseIndex * VARIANT_PITCH_PX;
    const maxLeft = -(sw.count - 1 - sw.baseIndex) * VARIANT_PITCH_PX;
    sw.dx = Math.max(maxLeft, Math.min(maxRight, clientX - sw.startX));
    // 毎フレームの追従は再レンダーを挟まず直接書く（再レンダー時も同じ値を描くので食い違わない）。
    const track = carouselTrackRef.current;
    if (track) track.style.transform = carouselTransform(sw);
    // 帯を左へ引く＝帯が左へ流れる＝右隣の差分が枠に入る（内容が指について動く向き）。
    const next = Math.max(
      0,
      Math.min(sw.count - 1, sw.baseIndex - Math.round(sw.dx / VARIANT_PITCH_PX)),
    );
    if (next !== sw.index) {
      sw.index = next;
      const stack = getNode(session.state, sw.stackId);
      if (stack && isVariantStack(stack)) peekVariant(stack, next);
    }
  };

  /** 覗き見をやめて実体の見た目へ戻す。 */
  const clearVariantPeek = () => {
    if (!variantPeekRef.current) return;
    variantPeekRef.current = null;
    setVariantPeek(null);
    repaint();
  };

  /** サムネイル帯の 1 枚を選んで確定（1 op = Undo 1 回）。 */
  const chooseVariant = (stack: LayerGroup, index: number) => {
    variantPeekRef.current = null;
    setVariantPeek(null);
    if (index === variantIndexOf(stack) || index < 0) {
      repaint(); // 覗き見をやめるだけ
      return;
    }
    markDirty('full'); // 差分の入れ替えは絵の全面が変わりうる
    session.apply(createSetVariantIndexOp(stack.id, index));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  /** 1 段ずらす（キーボードと一覧クリック用）。 */
  const stepVariant = (stack: LayerGroup, delta: number) => {
    const next = variantIndexOf(stack) + delta;
    if (next < 0 || next >= stack.children.length) return;
    chooseVariant(stack, next);
  };

  /** アクティブレイヤーを含む最も内側のスロット（フォルダを跨いでも遡る）。 */
  const activeVariantStack = (): LayerGroup | undefined => {
    let id: string | null = activeLayerId;
    for (let guard = 0; guard < 64 && id; guard++) {
      const info = getParentInfo(session.state, id);
      if (!info || !info.parentId) return undefined;
      const p = getNode(session.state, info.parentId);
      if (p && isVariantStack(p)) return p;
      id = info.parentId;
    }
    return undefined;
  };

  /** , / . で、いま描いているレイヤーが属するスロットの差分を往復する（A/B の見比べ用）。 */
  const stepActiveVariant = (delta: number) => {
    const stack = activeVariantStack();
    if (stack) stepVariant(stack, delta);
  };

  // ---- 状態(state)と所属(attachment) ------------------------------------------
  // 別の行に散らばった差分どうしの関係を、利用者が名前で覚えて手で揃えるのをやめて、
  // 「くっついている」という関係として保持する。維持はシステム側の仕事になる。

  /** 状態を 1 つ作る。この時点では何も所属していない（空のレールが 1 本立つだけ）。 */
  const addState = () => {
    session.apply(createAddStateOp(genId('state'), `ver${listStates(session.state).length + 1}`));
    onEdit();
  };

  /** 状態を消す。付いていた所属が一斉に外れるだけで、スロットは 1 つも消えない（規則7）。 */
  const deleteState = (st: VariantState) => {
    if (editingStateId === st.id) setEditingStateId(null);
    session.apply(createRemoveStateOp(st.id));
    onEdit();
  };

  const startStateRename = (st: VariantState) => {
    setEditingStateId(st.id);
    setEditingStateName(st.name);
  };

  const commitStateRename = (st: VariantState) => {
    setEditingStateId(null);
    const name = editingStateName.trim();
    if (!name || name === st.name) return;
    session.apply(createRenameStateOp(st.id, name));
    onEdit();
  };

  /**
   * 状態を出す。所属している行が一斉に切り替わり、スロットが 1 つの行（＝自動共有）は動かない。
   * これが 1 操作で済むかどうかが、この設計の一番の見どころ。
   */
  const applyStateNow = (st: VariantState) => {
    markDirty('full'); // 複数行の差分が入れ替わるので絵の全面が変わりうる
    session.apply(createApplyStateOp(st.id));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  /**
   * 行の上でレールを押したときの所属の付け外し（1 クリック）。
   *   付いていない            → いま出ているスロットにくっつける
   *   付いていて、それが今出ている → 外す（＝この行ではどのスロットも選ばない。規則4）
   *   付いているが別のスロット   → いま出ているスロットへ付け替える
   * 「いま出ているスロット」を宛先にするので、行に見えているものと結果が一致する。
   */
  const toggleAttachment = (stateId: string, rowId: string) => {
    const t = attachTarget(session.state, rowId);
    if (!t) return;
    const cur = liveAttachment(session.state, stateId, t.stack.id);
    const next = cur?.slotId === t.slotId ? null : t.slotId;
    session.apply(createSetAttachmentOp(stateId, t.stack.id, next));
    onEdit();
  };

  // 保留中ならしきい値超えで本ドラッグを開始。ドラッグ中は pointer 位置の直下の行を判定し、
  // 上/中/下のドロップ位置ヒントを更新する。
  const onRowPointerMove = (e: ReactPointerEvent) => {
    // 差分スライド中: カルーセルを指に追従させ、中央の枠に来た 1 枚を覗き見する。
    if (swipeRef.current) {
      if (e.pointerId === swipeRef.current.pointerId) updateSwipe(e.clientX);
      return;
    }
    if (!dragIdRef.current) {
      // まだ持ち上がっていない。動き出したなら、それはスライド（差分の切り替え）。
      const p = pendingDragRef.current;
      if (!p || e.pointerId !== p.pointerId) return;
      if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) < LAYER_GESTURE_THRESHOLD) return;
      const stack = getNode(session.state, p.id);
      if (stack && isVariantStack(stack) && stack.children.length >= 2) {
        cancelLiftTimer(); // スライドに入ったら持ち上げない（片方だけが起きる）
        const at = variantIndexOf(stack);
        swipeRef.current = {
          stackId: stack.id,
          pointerId: p.pointerId,
          startX: p.startX,
          baseIndex: at,
          count: stack.children.length,
          index: at,
          dx: 0,
        };
        capturePointer(p.el, p.pointerId);
        pendingDragRef.current = null;
        setSwipingStackId(stack.id); // カルーセルを出す
        updateSwipe(e.clientX); // 開始した move の移動量もその場で反映する
      }
      // 差分を持たない行は、動かしても何も起きない（長押しすれば持ち上がる）。
      return;
    }
    const dragged = dragIdRef.current;
    if (!dragged) return;
    positionGhost(e.clientX, e.clientY);
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const head = el?.closest('.layer-head') as HTMLElement | null;
    const targetId = head?.dataset.id;
    const tn = targetId ? getNode(session.state, targetId) : undefined;
    const dn = getNode(session.state, dragged);
    if (!head || !targetId || !tn || targetId === dragged || (dn && collectNodeIds(dn).includes(targetId))) {
      setDropHint((p) => (p ? null : p));
      return;
    }
    const rect = head.getBoundingClientRect();
    const r = (e.clientY - rect.top) / Math.max(1, rect.height);
    // 掴んだ位置から横へ大きくずらしていたら「横に並べる（差分にする）」。
    // 縦にずらしているだけなら今までどおりの並べ替え／フォルダ出し入れ。
    const dx = e.clientX - (dragOriginRef.current?.x ?? e.clientX);
    let pos: DropPos;
    if (Math.abs(dx) >= VARIANT_DROP_DX) {
      pos = dx < 0 ? 'left' : 'right';
    } else if (isGroup(tn) && !isEmptySlot(tn)) {
      // 空スロットは「何も無い」を表す中身なので、収納先にはできない（中身が入れば空でなくなる）。
      pos = r < 0.28 ? 'above' : r > 0.72 ? 'below' : 'into';
    } else {
      pos = r < 0.5 ? 'above' : 'below';
    }
    setDropHint((p) => (p && p.id === targetId && p.pos === pos ? p : { id: targetId, pos }));
  };

  const onRowPointerUp = (e: ReactPointerEvent) => {
    pendingDragRef.current = null;
    cancelLiftTimer();
    // スライドの確定: 動いていれば 1 op（Undo 1 回）、動いていなければ覗き見を戻すだけ。
    const sw = swipeRef.current;
    if (sw) {
      gestureConsumedRef.current = true; // 後続の click を選択として扱わない
      swipeRef.current = null;
      setSwipingStackId(null); // カルーセルを畳む
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 既に解放済み */
      }
      const stack = getNode(session.state, sw.stackId);
      if (stack && isVariantStack(stack)) chooseVariant(stack, sw.index);
      else clearVariantPeek();
      return;
    }
    const dragged = dragIdRef.current;
    if (!dragged) return; // 持ち上がる前に離した＝クリック。選択/リネーム/ボタンの通常処理に任せる。
    gestureConsumedRef.current = true; // 持ち上げて離した＝移動。後続の click は選択にしない
    const hint = dropHint;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 既に解放済み */
    }
    dragIdRef.current = null;
    dragOriginRef.current = null;
    setDragGhost(null);
    setDropHint(null);
    if (!dragged) return;
    if (hint) {
      performDrop(dragged, hint.id, hint.pos);
      return;
    }
    const over = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    // 行の上でなく、レイヤーリストの余白で離したときは最上位の最前面へ（フォルダから出す）。
    if (
      over &&
      !over.closest('.layer-head') &&
      over.closest('.layer-list') &&
      getNode(session.state, dragged)
    ) {
      moveNode(dragged, null, Number.MAX_SAFE_INTEGER);
    }
  };

  const performDrop = (draggedId: string, targetId: string, pos: DropPos) => {
    if (draggedId === targetId) return;
    const dn = getNode(session.state, draggedId);
    const tn = getNode(session.state, targetId);
    if (!dn || !tn || collectNodeIds(dn).includes(targetId)) return; // 子孫へは不可
    // 行の左右の肩へ落とした = 縦に積むのではなく横に並べる（＝そのスロットの差分にする）。
    // 相手がまだ普通のレイヤーでも、その場で横軸（差分スタック）に化ける。
    if (pos === 'left' || pos === 'right') {
      dropBesideAsVariant(draggedId, targetId, pos);
      return;
    }
    // 差分スタック（横軸）の行の中央へ落とした = そのスロットの差分にする。
    if (pos === 'into' && isVariantStack(tn)) {
      dropAsVariant(draggedId, tn);
      return;
    }
    // 移動先の親と挿入位置を決める。
    let newParentId: string | null;
    let index: number;
    if (pos === 'into') {
      newParentId = targetId;
      index = Number.MAX_SAFE_INTEGER; // フォルダの先頭(最前面)へ
    } else {
      const info = getParentInfo(session.state, targetId);
      if (!info) return;
      const from = getParentInfo(session.state, draggedId);
      const sameParent = from && from.parentId === info.parentId ? from.index : null;
      newParentId = info.parentId;
      // 差分スタックを開いた一覧は左→右を上→下にそのまま並べるので、逆順ではない。
      const parent = info.parentId ? getNode(session.state, info.parentId) : null;
      const reversed = !(parent && isVariantStack(parent));
      index = reorderIndex(pos, info.index, sameParent, reversed);
    }
    moveNode(draggedId, newParentId, index);
  };

  /**
   * 行の左右の肩へ落として「その隣の差分」にする（＝差分づくりを D&D のアフォーダンスで行う）。
   * 相手がまだ普通のレイヤー／フォルダなら、その場で横軸（差分スタック）に包まれる。
   * 1 ドロップ = 1 op なので Undo 1 回で元の縦積みに戻る。
   */
  const dropBesideAsVariant = (draggedId: string, targetId: string, side: 'left' | 'right') => {
    markDirty('full'); // 差分の入れ替えは絵の全面が変わりうる
    session.apply(createMoveAsVariantOp(draggedId, targetId, genId('vstack'), side));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  // 既存のレイヤーをスロットへ落として「そのスロットの差分」にする。
  // 落としたものをそのまま表示中の差分にするので、結果が即座に見える。
  const dropAsVariant = (draggedId: string, stack: LayerGroup) => {
    const at = variantIndexOf(stack);
    const already = stack.children.findIndex((c) => c.id === draggedId);
    markDirty('full');
    if (already >= 0) {
      // 既にこのスロットの差分 → 表示をそれに切り替えるだけ。
      session.apply(createSetVariantIndexOp(stack.id, already));
    } else {
      session.applyBatch([
        createMoveNodeOp(draggedId, stack.id, at + 1),
        createSetVariantIndexOp(stack.id, at + 1),
      ]);
    }
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  // ノードを newParentId（null=最上位）の index へ移す（並べ替え / フォルダ出し入れ）。全ノードが
  // 1つのキャンバス座標系を共有するので、内容(offset)は動かさず z 順/親だけを付け替える非破壊操作。
  const moveNode = (draggedId: string, newParentId: string | null, index: number) => {
    const dn = getNode(session.state, draggedId);
    if (!dn) return;
    markDirty('full');
    session.apply(createMoveNodeOp(draggedId, newParentId, index));
    setActiveLayerId(draggedId);
    onEdit();
  };

  const startRename = (n: LayerNode) => {
    setEditingLayerId(n.id);
    setEditingName(n.name);
  };

  const commitRename = (n: LayerNode) => {
    const name = editingName.trim();
    setEditingLayerId(null);
    if (name && name !== n.name) {
      session.apply(createRenameLayerOp(n.id, name));
      onEdit();
      repaint();
    }
  };

  const toggleCollapse = (g: LayerGroup) => {
    session.apply(createSetGroupCollapsedOp(g.id, !g.collapsed));
    onEdit();
  };

  // 空フォルダを最上位に追加。
  const addFolder = () => {
    session.apply(createAddGroupOp(genId('group'), `Folder ${session.state.layers.length}`));
    onEdit();
    repaint();
  };

  // レイヤー名クリック: その行を「操作の対象」にする（リーフなら描き先も一緒に動く）。
  // フォルダの開閉は ▸/▾ に任せる（クリックの意味を1つに保ち、選ぶたびに畳まれないようにする）。
  const onLayerClick = (n: LayerNode) => {
    setSelectedId(n.id);
    if (!isGroup(n)) setActiveLayerId(n.id); // 描き先はリーフのときだけ動かす
  };

  const onOpacityInput = (n: LayerNode, v: number) => {
    setOpacityDraft({ id: n.id, v });
    opacityPreviewRef.current = { layerId: n.id, opacity: v };
    // スライダー移動のたびに全面 flatten していたのを、そのレイヤーの内容 bbox だけの部分再描画にする
    // （4K でもドラッグが軽い）。グループは footprint 不定なので全面。
    const region = nodeRegion(n);
    if (region) repaintRegion(region);
    else repaint();
  };

  const commitOpacity = (n: LayerNode) => {
    const pv = opacityPreviewRef.current;
    opacityPreviewRef.current = null;
    setOpacityDraft(null);
    const region = nodeRegion(n);
    if (pv && pv.layerId === n.id && Math.abs(pv.opacity - n.opacity) > 1e-6) {
      markDirty(region ?? 'full');
      session.apply(createSetLayerOpacityOp(n.id, pv.opacity, region));
      onEdit();
    } else if (region) {
      repaintRegion(region); // 変更なし: プレビューを実体へ戻す
    } else {
      repaint();
    }
  };

  // ---- レイヤー行サムネイル（内容が変わった行だけ再生成してキャッシュ） ----
  const bufId = (b: ImageBuffer): number => {
    let id = bufIdRef.current.get(b);
    if (id === undefined) {
      id = ++bufSeqRef.current;
      bufIdRef.current.set(b, id);
    }
    return id;
  };
  // 合成結果に影響する要素の署名（グループサムネは子の可視/不透明度/クリップ/合成方法/内容で決まる）。
  const blendSig = (n: LayerNode): string => (n.blendMode === 'multiply' ? 'm' : '');
  const renderSig = (n: LayerNode): string =>
    isGroup(n)
      ? `g${n.visible ? 1 : 0}.${Math.round(n.opacity * 100)}${blendSig(n)}[${n.children
          .map(renderSig)
          .join(',')}]`
      : `l${bufId(n.buffer)}@${n.offsetX},${n.offsetY}.${n.visible ? 1 : 0}.${Math.round(
          n.opacity * 100,
        )}.${n.clipped ? 1 : 0}${blendSig(n)}`;
  // そのノード自身のサムネ署名（リーフは内容のみ、グループは子の合成結果）。
  const thumbSig = (n: LayerNode): string =>
    isGroup(n)
      ? `G[${n.children.map(renderSig).join(',')}]`
      : `L${bufId(n.buffer)}@${n.offsetX},${n.offsetY}`;

  const buildThumbUrl = (node: LayerNode): string => {
    const gw = LAYER_THUMB_W * 2;
    const gh = LAYER_THUMB_H * 2;
    // 横軸のスロットが渡されたら、いま出ている差分のサムネを出す（全差分を重ねない）。
    const n = isVariantStack(node) ? (activeVariant(node) ?? node) : node;
    if (isGroup(n)) {
      // 子だけを透明背景で合成（クリップ/不透明度/可視を反映）。全体を縮小表示する。
      const flat = flattenState(
        { width, height, layers: n.children, activeLayerId: '' },
        { background: [0, 0, 0, 0] },
      );
      return bufferToDataURL(flat, gw, gh, null);
    }
    // リーフは buffer を直接使い、内容 bbox（buffer ローカル座標）に寄せて切り出す。
    const bb = layerContentBBox(n); // canvas 座標
    const region = bb.w > 0 ? { x: bb.x - n.offsetX, y: bb.y - n.offsetY, w: bb.w, h: bb.h } : null;
    return bufferToDataURL(n.buffer, gw, gh, region);
  };

  const layerThumb = (n: LayerNode): string => {
    const sig = thumbSig(n);
    const cache = thumbCacheRef.current;
    const hit = cache.get(n.id);
    if (hit && hit.sig === sig) return hit.url;
    const url = buildThumbUrl(n);
    cache.set(n.id, { sig, url });
    return url;
  };

  // レイヤーツリーを再帰描画（フォルダは折りたたみ可。表示は上=最前面なので reverse）。
  const renderNode = (n: LayerNode, depth: number, siblings: LayerNode[]) => {
    const stack = isVariantStack(n) ? n : null;
    // スライド中はまだ確定していない差分を先に見せる（離した時点で確定）。
    const shownIndex = stack
      ? variantPeek?.stackId === stack.id
        ? variantPeek.index
        : variantIndexOf(stack)
      : -1;
    const node = stack ? stack.children[shownIndex] : n;
    if (!node) return null; // 空スタック（通常は起きない）は行を出さない
    // 横軸のどちら側にまだ差分が残っているか（カルーセルは端で止まる＝巡回しないので、
    // 端では「その向きにはもう無い」と言い切れる）。サムネイルの左右の四角に使う。
    const hasPrevVariant = !!stack && shownIndex > 0;
    const hasNextVariant = !!stack && shownIndex < stack.children.length - 1;
    const slotId = stack ? stack.id : node.id;
    const emptySlot = isEmptySlot(node); // この行にいま出ているのは「何も無い」
    const grp = isGroup(node) && !emptySlot ? node : null; // 空スロットはフォルダとして扱わない
    const leaf = isGroup(node) ? null : (node as Layer);
    const editing = editingLayerId === node.id;
    const active = !isGroup(node) && node.id === activeLayerId;
    // 「行として絵から外れている」かはスロット側（行）の性質。中身ごとの非表示は持たせないので、
    // スロット行では stack.visible を見る（＝表示ボタンの効き先と一致させる）。
    const rowHidden = stack ? !stack.visible || !node.visible : !node.visible;
    // 上のボタン群が効く行。スロット行はスロット id でも中の差分 id でも選ばれたことにする
    // （opTarget がスロット → 出ている差分へ解決するので、どちらで選んでも同じ行が対象になる）。
    const selected = selectedId === slotId || selectedId === node.id;
    const dropCls = dropHint?.id === slotId ? ` drop-${dropHint.pos}` : '';
    return (
      <li
        key={slotId}
        className={`layer-item ${grp ? 'is-group' : ''} ${active ? 'active' : ''}${
          selected ? ' selected' : ''
        }${rowHidden ? ' is-hidden' : ''}${emptySlot ? ' is-empty-slot' : ''}${
          leaf?.clipped ? ' is-clipped' : ''
        }${stack ? ' has-variants' : ''}${
          variantPeek?.stackId === slotId ? ' peeking' : ''
        }${dragGhost?.id === slotId ? ' lifted' : ''}${dropCls}`}
      >
        <div
          className="layer-head"
          data-id={slotId}
          style={{ paddingLeft: 4 + depth * 12 }}
          onPointerDown={(e) => onRowPointerDown(n, e)}
          onPointerMove={onRowPointerMove}
          onPointerUp={onRowPointerUp}
          onPointerCancel={onRowPointerUp}
          // 行のどこを押しても選べる（行からボタンを外したぶん、当たり判定を行全体に広げる）。
          // スライド／移動の直後に届く click は選択として扱わない（gestureConsumedRef のコメント参照）。
          onClick={() => {
            if (gestureConsumedRef.current) return;
            onLayerClick(node);
          }}
          // 長押し中にコンテキストメニューが割り込むと持ち上げが中断されるので抑止する。
          onContextMenu={(e) => e.preventDefault()}
        >
          <span
            className="layer-grip"
            title={
              stack
                ? 'ここを掴むとすぐ持ち上がる（移動）／行を左右にドラッグ＝差分の切り替え／長押しでも持ち上がる'
                : 'ここを掴むとすぐ持ち上がる（移動）／行は長押しで持ち上がる'
            }
          >
            {stack ? '⇹' : '⠿'}
          </span>
          {/* 開閉はフォルダ（縦軸）だけの操作。横軸は下に開かない: 差分は行の上で左右に
              並んでいるものとして扱い、確認も切り替えもサムネイル上の左右スライドで完結させる。
              縦に開けてしまうと、同じものが縦にも横にも居ることになり軸の区別が壊れる。 */}
          {grp ? (
            <button
              className="icon-btn"
              title={grp.collapsed ? '展開' : '折りたたみ'}
              onClick={() => toggleCollapse(grp)}
            >
              {grp.collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="layer-indent" />
          )}
          {/* サムネイルと、その背後に重なる横軸の札。左右の端だけ覗かせて「この行には横軸があり、
              まだその向きに差分が重なっている」ことを示す。端（1 枚目の左／最後の 1 枚の右）では
              見えなくなるが、場所は空けたまま（visibility）にする: 詰めてしまうと端に着くたびに
              サムネイルが左右へ動き、行に重ねて出るカルーセルの中央枠とも位置がずれるため。
              押せる小物は行に置かない方針なので、これは表示だけ（切り替えは行の左右ドラッグ）。 */}
          <span className="thumb-axis">
            {stack && (
              <span
                className={`axis-stub left${hasPrevVariant ? '' : ' is-end'}`}
                title="左にまだ差分があります（行を左右にドラッグして切り替え）"
              />
            )}
            {emptySlot ? (
              // 空スロットは中身が無いので、サムネイルの代わりに「無い」ことを描く枠を置く
              // （画素が無いだけの真っ白なサムネイルと見分けが付かなくなるのを避ける）。
              <span className="layer-thumb is-empty" title="何も無い（この行は絵に出ません）" />
            ) : (
              <img
                className="layer-thumb"
                src={layerThumb(node)}
                alt=""
                draggable={false}
                title="レイヤーの内容"
              />
            )}
            {stack && (
              <span
                className={`axis-stub right${hasNextVariant ? '' : ' is-end'}`}
                title="右にまだ差分があります（行を左右にドラッグして切り替え）"
              />
            )}
          </span>
          {editing ? (
            <input
              className="layer-name-input"
              autoFocus
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              onBlur={() => commitRename(node)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(node);
                else if (e.key === 'Escape') setEditingLayerId(null);
              }}
            />
          ) : (
            <span
              className="layer-name"
              onDoubleClick={emptySlot ? undefined : () => startRename(node)}
              title={
                emptySlot
                  ? 'この行が「何も無い」を選んでいる状態（名前は付けません）'
                  : 'クリックで選択（上のボタンの効き先になる）/ ダブルクリックで名称変更'
              }
            >
              {grp ? '📁 ' : ''}
              {node.name}
              {leaf && (leaf.offsetX !== 0 || leaf.offsetY !== 0) && (
                <span className="muted">
                  {' '}
                  @({leaf.offsetX},{leaf.offsetY})
                </span>
              )}
            </span>
          )}
          <span className="layer-actions">
            {stack && (
              // 「横に何枚あって、いま何枚目か」だけを小さく出す。実際の選択はスライド（カルーセル）で行う。
              <span
                className="variant-count"
                title={`差分 ${stack.children.length} 枚。行を左右にドラッグして切り替え（帯が指について動きます）`}
              >
                {shownIndex + 1}/{stack.children.length}
              </span>
            )}
            {/* 状態の印（押せない・ただの表示）。操作ボタンは全部パネル上部にあるので、行に残すのは
                「いまこの行がどうなっているか」だけ。押せる小物を行から無くしておくことで、
                行そのものを別の見せ方（差分どうしの関係の図示など）に使えるようにしている。 */}
            {rowHidden && (
              // 「行ごと絵から外れている」印。中身ごとの非表示は持たせないので、スロット行では
              // スロット側の非表示を示す（＝上の表示ボタンの効き先と一致する）。
              <span
                className="layer-flag is-hidden-flag"
                title={
                  stack
                    ? 'この行ごと非表示（一時的。全状態に効きます。「この状態では出さない」は空スロットで表します）'
                    : '非表示（絵に出ていない）'
                }
              >
                非
              </span>
            )}
            {leaf?.clipped && (
              <span className="layer-flag is-clip-flag" title="下のレイヤーにクリップ中">
                ⤵
              </span>
            )}
          </span>
        </div>
        {/* 左右スライド中だけ出るカルーセル。行の上に重ねるので（position:absolute）
            レイアウトはびくとも動かず、指の動きにサムネイルがそのまま付いてくる。
            中央の枠に来ている 1 枚がキャンバスにも出ていて、離すとそれで確定する。
            「何段ドラッグすれば隣へ行くか」が絵で見えるので、見えない数え上げにならない。 */}
        {stack && swipingStackId === stack.id && (
          <div className="variant-carousel">
            <div
              className="vc-track"
              ref={carouselTrackRef}
              style={{
                transform: carouselTransform(swipeRef.current ?? { baseIndex: shownIndex, dx: 0 }),
              }}
            >
              {stack.children.map((c, i) => (
                <span key={c.id} className={`vc-chip${i === shownIndex ? ' on' : ''}`}>
                  <img src={layerThumb(c)} alt="" draggable={false} />
                </span>
              ))}
            </div>
            <div className="vc-frame" />
            <span className="vc-label">
              {shownIndex + 1}/{stack.children.length} {stack.children[shownIndex]?.name ?? ''}
            </span>
          </div>
        )}
        {grp && !grp.collapsed && (
          <ul className="layer-list nested">
            {grp.children
              .slice()
              .reverse()
              .map((c) => renderNode(c, depth + 1, grp.children))}
          </ul>
        )}
      </li>
    );
  };

  /**
   * 行 × 状態 の交点に打つ印。押すと所属が付いたり外れたりする（ここが唯一の所属の作り口）。
   * 素通り（スロットが 1 つの行）には何も置かない ＝ 操作も宣言も要らないことが、
   * 何も足さない見た目に対応する。
   */
  const renderRailMark = (
    st: VariantState,
    x: number,
    color: string,
    row: { id: string; y: number; h: number },
    cell: RailCell,
  ) => {
    if (cell === 'pass') return null;
    // 指せるのは「行の中のスロット」だけ。ここが null の行（選ばれていないスロットの中身など）は
    // 所属の宛先になれないので、印も当たり判定も出さない。
    const t = attachTarget(session.state, row.id);
    if (!t) return null;
    const slotName = getNode(session.state, t.slotId)?.name ?? '';
    const cy = row.y + row.h / 2;
    // その印が指しているスロット（畳んだ行なら所属先、開いた行ならその行自身）が空スロットか。
    // 「ここに中身を置く」と「ここは何も出さない」は関係としては同格なので、印の形で区別する
    // （丸＝中身がある / 横棒＝空）。ver1 が 4 行のうち 1 行では「無し」を選んでいる、が一目で読める。
    const att = liveAttachment(session.state, st.id, t.stack.id);
    const markSlotId = cell === 'dot' ? row.id : att?.slotId;
    const markEmpty = !!markSlotId && isEmptySlot(getNode(session.state, markSlotId) ?? t.stack);
    const kindWord = markEmpty ? '「何も無い」' : `「${slotName}」`;
    const label =
      cell === 'knobOn'
        ? `${st.name}：この行では${kindWord}（いま出ているもの）。押すと外す`
        : cell === 'knobOff'
          ? `${st.name}：この行では${kindWord}を使うのに、別のものが出ている（ズレ）。押すと「${slotName}」に付け替える`
          : cell === 'dot'
            ? `${st.name}：${markEmpty ? 'この行では何も出さない' : 'このスロットに所属'}。押すと外す`
            : `${st.name}：この行ではどのスロットも選んでいない。押すと${
                isEmptySlot(getNode(session.state, t.slotId) ?? t.stack)
                  ? '「何も出さない」'
                  : `「${slotName}」`
              }にくっつける`;
    return (
      <g
        key={`${st.id}:${row.id}`}
        className="rail-hit"
        onClick={() => toggleAttachment(st.id, row.id)}
      >
        <title>{label}</title>
        {/* 指でも押せる当たり判定（見えない）。印そのものは小さくしておきたいので分ける。 */}
        <circle className="rail-hit-area" cx={x} cy={cy} r={9} />
        {cell === 'knobOn' &&
          (markEmpty ? (
            <line className="rail-dash" x1={x - RAIL_KNOB_R} y1={cy} x2={x + RAIL_KNOB_R} y2={cy} stroke={color} />
          ) : (
            <circle cx={x} cy={cy} r={RAIL_KNOB_R} fill={color} />
          ))}
        {cell === 'knobOff' &&
          (markEmpty ? (
            <line
              className="rail-dash off"
              x1={x - RAIL_KNOB_R}
              y1={cy}
              x2={x + RAIL_KNOB_R}
              y2={cy}
              stroke={color}
            />
          ) : (
            <circle className="rail-knob-off" cx={x} cy={cy} r={RAIL_KNOB_R} stroke={color} />
          ))}
        {cell === 'dot' &&
          (markEmpty ? (
            <line className="rail-dash" x1={x - RAIL_DOT_R - 1} y1={cy} x2={x + RAIL_DOT_R + 1} y2={cy} stroke={color} />
          ) : (
            <circle cx={x} cy={cy} r={RAIL_DOT_R} fill={color} />
          ))}
        {cell === 'gap' && (
          <circle className="rail-open" cx={x} cy={cy} r={RAIL_KNOB_R - 1} stroke={color} />
        )}
      </g>
    );
  };

  /**
   * 状態のレール。状態ごとに 1 本の縦線をリストの左に立て、行との交点に印を打つ。
   *
   * 点と点を総当たりで結ぶ（ノードグラフ）のを避けて 1 本に束ねているのは 3 つの理由から:
   *   1. 状態そのものが「押せる対象」になる（上の名札がレールの頭）。線だけでは選ぶ先が無い。
   *   2. 「所属していない」が**線の途切れ**として見える。線が無いことは背景と区別できないので、
   *      メッシュだと「自動共有されている」と「どれも選んでいない」が同じ見た目になってしまう。
   *   3. レイヤーの縦順は合成順なので動かせない。総当たりの線は交差しっぱなしになる。
   *
   * 素通り（スロットが 1 つの行）は線が通るだけで印は無い。規則3「宣言も操作も要らない」が
   * そのまま「何も足さない見た目」に対応する。
   */
  const renderStateRails = (states: readonly VariantState[]) => {
    if (states.length === 0 || railRows.length === 0) return null;
    return (
      <svg className="rail-svg">
        {states.map((st, si) => {
          const x = RAIL_PAD_L + si * RAIL_PITCH;
          const color = railColor(si);
          const cells = railRows.map((r) => railCell(session.state, st.id, r.id));
          // 途切れていない区間だけを線にする。1 区間は「最初の行の上端から最後の行の下端まで」の
          // 1 本なので、行の間に挟まる見出し（差分一覧のキャプション等）も自然に跨げる。
          const segs: { y1: number; y2: number }[] = [];
          let from = -1;
          for (let i = 0; i <= railRows.length; i++) {
            const on = i < railRows.length && cells[i] !== 'gap';
            if (on && from < 0) from = i;
            if (!on && from >= 0) {
              const a = railRows[from];
              const b = railRows[i - 1];
              segs.push({ y1: a.y - RAIL_BRIDGE, y2: b.y + b.h + RAIL_BRIDGE });
              from = -1;
            }
          }
          return (
            <g key={st.id}>
              {segs.map((s, i) => (
                <line className="rail-line" key={i} x1={x} y1={s.y1} x2={x} y2={s.y2} stroke={color} />
              ))}
              {railRows.map((r, i) => renderRailMark(st, x, color, r, cells[i]))}
            </g>
          );
        })}
      </svg>
    );
  };

  // 状態の一覧と、レールを引くために左に空ける幅。状態が 0 本なら幅も 0 で、
  // 状態を作っていないうちはレイヤーパネルの見た目が今までとまったく変わらない。
  const stateList = listStates(session.state);
  const railGutterW = stateList.length
    ? RAIL_PAD_L + (stateList.length - 1) * RAIL_PITCH + RAIL_KNOB_R + RAIL_PAD_R
    : 0;

  return (
    <div className="editor" ref={paneRef}>
      <div
        className={`canvas-viewport ${zoomKey ? 'zoom-mode' : ''} ${spaceHeld ? 'pan-mode' : ''}`}
        ref={viewportRef}
        onPointerDown={onViewportPointerDown}
      >
        {/* stage（作業場座標系）: pan(translate) を担う外側ラッパ。ジェスチャ中は stageRef 経由で
            transform を命令的に更新し、React 再レンダーを挟まない（初期値/確定は panRef.current で描く）。
            zoom(scale) は内側 .canvas-pan が担い、pan と zoom を別レイヤーに分離する。 */}
        <div
          ref={stageRef}
          className="canvas-stage"
          style={{ transform: `translate(${panRef.current.x}px, ${panRef.current.y}px)` }}
        >
          <div className="canvas-pan" style={{ transform: `scale(${zoom})` }}>
          {/* アートボード（最終画像になる矩形）。ライブ canvas をここに置く。白い紙が「枠の中」。 */}
          <div className="board-tile-host focused" style={{ left: focusX, top: focusY }}>
            <canvas
              ref={canvasRef}
              className="edit-canvas"
              width={width}
              height={height}
              style={{
                width,
                height,
                touchAction: 'none',
                cursor: showCursor ? 'none' : 'crosshair',
                imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={(e) => e.preventDefault()} // 右ボタンはスポイトに使うのでメニューを出さない
              onPointerEnter={(e) => {
                setHovering(true);
                moveCursor(e.clientX, e.clientY);
              }}
              onPointerLeave={() => setHovering(false)}
            />
            {/* 選択範囲の点線と投げ縄ドラッグを描く重ね canvas。絵の canvas を汚さないので、
                点線を動かしても投げ縄を引いてもレイヤー合成をやり直さずに済む（当たり判定は持たない）。 */}
            <canvas
              ref={selCanvasRef}
              className="selection-overlay"
              width={width}
              height={height}
              style={{ width, height }}
            />
          </div>
        </div>
          {/* リサイズ・ドラッグ中に出す破線プレビュー枠（アートボード原点 0,0 起点）。大きさは命令的に更新。 */}
          <div ref={resizeOutlineRef} className="resize-outline" style={{ display: 'none' }} />

          {/* 辺リサイズ・ハンドル（右辺＝幅 / 下辺＝高さ）。掴んで引っ張るとサイズが変わる（離すと確定）。
              canvas-stage 内なので pan に追従し、scale の外なので見た目サイズは一定。 */}
          <div
            className="resize-handle resize-handle-right"
            style={{ left: width * zoom, top: (height * zoom) / 2 }}
            title="ドラッグで幅を変更（内容は消えません）"
            onPointerDown={(e) => onResizeHandleDown('w', e)}
            onPointerMove={onResizeHandleMove}
            onPointerUp={onResizeHandleUp}
            onPointerCancel={onResizeHandleUp}
          >
            <span className="resize-grip">⇔</span>
          </div>
          <div
            className="resize-handle resize-handle-bottom"
            style={{ left: (width * zoom) / 2, top: height * zoom }}
            title="ドラッグで高さを変更（内容は消えません）"
            onPointerDown={(e) => onResizeHandleDown('h', e)}
            onPointerMove={onResizeHandleMove}
            onPointerUp={onResizeHandleUp}
            onPointerCancel={onResizeHandleUp}
          >
            <span className="resize-grip">⇕</span>
          </div>
        </div>
      </div>

      <div
        ref={cursorRef}
        className={`brush-cursor ${sizeAdjust ? 'sizing' : ''}`}
        style={{
          width: size * zoom,
          height: size * zoom,
          display: showCursor && hovering ? 'block' : 'none',
          // 消す一筆（消しゴム or 透明色）は白いリングで「色を置かない」ことを示す。
          borderColor: sizeAdjust ? '#56ccf2' : erasing ? '#fff' : color,
        }}
      >
        {sizeAdjust && <span className="brush-cursor-label">{size}px</span>}
      </div>

      {/* レイヤー D&D 中に pointer へ追従する半透明ゴースト（マウス/ペン/タッチ共通）。
          行の左右の肩に来ているときは「差分になる」ことをその場で言葉でも示す。 */}
      <div ref={ghostRef} className="layer-drag-ghost" style={{ display: dragGhost ? 'block' : 'none' }}>
        {dragGhost?.name}
        {(dropHint?.pos === 'left' || dropHint?.pos === 'right') && (
          <span className="drag-ghost-badge">
            {dropHint.pos === 'left' ? '← 差分にする' : '差分にする →'}
          </span>
        )}
      </div>

      {/* キャンバス下部のフロートバー: ズーム・視点移動 */}
      <div className="float-canvasbar">
        <button onClick={() => zoomByCenter(1 / 1.25)} title="縮小">−</button>
        <span className="zoom-val" onClick={resetZoom} title="クリックで100%">
          {Math.round(zoom * 100)}%
        </span>
        <button onClick={() => zoomByCenter(1.25)} title="拡大">＋</button>
        <button onClick={resetZoom}>100%</button>
        <button onClick={fitZoom}>Fit</button>
        <span className={`keyhint-badge ${zoomKey ? 'on' : ''}`} title="Z を押しながらキャンバスを上下ドラッグでズーム">
          Z＋上下ドラッグ＝ズーム
        </span>
        <span className={`keyhint-badge ${spaceHeld ? 'on' : ''}`} title="Space を押しながらドラッグで視点移動">
          Space＝視点移動
        </span>
      </div>

      <FloatWindow id="nrc-tools" title="Tools" defaultPos={{ left: 12, top: 12 }} className="float-tools">
        <Section title="TOOLS" defaultOpen>
          <div className="tool-row">
            <button onClick={doUndo} disabled={!session.canUndo()} title="Undo (Ctrl+Z)">
              <ToolIcon name="undo" size={15} /> Undo
            </button>
            <button
              onClick={doRedo}
              disabled={!session.canRedo()}
              title="Redo (Ctrl+Shift+Z)"
            >
              <ToolIcon name="redo" size={15} /> Redo
            </button>
          </div>

          {/* ツールパレット: 役割ごとに小見出しを付けたアイコングリッド。
              名前・ショートカット・説明は title（ツールチップ）に入れ、盤面は記号だけで済ませる。 */}
          {TOOL_GROUPS.map((g) => (
            <div className="tool-group" key={g.label}>
              <div className="tool-group-label">{g.label}</div>
              <div className="tool-grid">
                {g.tools.map((t) => (
                  <button
                    key={t.id}
                    className={`tool-btn${tool === t.id ? ' active' : ''}`}
                    onClick={() => setTool(t.id)}
                    title={`${t.label}（${t.key}）\n${t.hint}`}
                    aria-label={t.label}
                    aria-pressed={tool === t.id}
                  >
                    <ToolIcon name={t.icon} />
                    <span className="tool-btn-key">{t.key}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="tool-current">{toolLabel}</div>

          {/* 選択範囲の状態。ある間だけ出す（無いときは「全面に描ける」＝説明する必要がない）。 */}
          {selectionInfo && (
            <div className="selection-bar">
              <ToolIcon name="lassoSelect" size={14} />
              <span className="selection-bar-text">
                選択中 {selectionInfo.w}×{selectionInfo.h}（{selectionInfo.area.toLocaleString()}px）
              </span>
              <button
                className="icon-btn"
                onClick={clearSelection}
                title="選択解除 (Ctrl+D)"
              >
                <ToolIcon name="deselect" size={14} /> 解除
              </button>
            </div>
          )}
          {(tool === 'lassoSelect' || tool === 'lassoFill') && (
            <p className="hint">
              {tool === 'lassoSelect'
                ? '囲った内側だけが描ける状態になります。Shift=追加 / Alt=削除 / Shift+Alt=交差／Ctrl+D=解除。'
                : '囲った内側を現在の色で塗ります。線が閉じていない下描きでも思った範囲に色を置けます。'}
            </p>
          )}
          {showCursor && (
            <>
              <label className="field">
                <span>
                  {toolLabel} の太さ {size}px
                </span>
                <input
                  type="range"
                  min={1}
                  max={80}
                  value={size}
                  onChange={(e) => setSize(Number(e.target.value))}
                />
              </label>
              <span className={`keyhint-badge ${sizeAdjust ? 'on' : ''}`}>
                S 押下＋キャンバスを上下ドラッグ＝太さ調整
              </span>
            </>
          )}
          <label className="field">
            <span>opacity {opacity.toFixed(2)}</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </label>
          {tool === 'bucket' && (
            <label className="field">
              <span>fill tolerance {tolerance}</span>
              <input
                type="range"
                min={0}
                max={128}
                value={tolerance}
                onChange={(e) => setTolerance(Number(e.target.value))}
              />
            </label>
          )}
          {tool === 'transform' && (
            <p className="hint">
              枠内ドラッグ=移動／頂点□=拡大縮小（Shift で縦横独立）／辺=回転（Shift で15°刻み）。
              1ドラッグ = 1操作として記録されます。
            </p>
          )}
          <p className="hint">
            B=ブラシ N=Gペン P=鉛筆 A=エア E=消しゴム G=塗りつぶし U=投げ縄塗り I=スポイト
            L=直線 R=矩形 M=投げ縄選択 V=変形／
            S押下＋上下ドラッグ or [ ]=サイズ／X=メイン⇄サブ C=透明／, .=差分の切替／
            Ctrl+Z=Undo Ctrl+Shift+Z=Redo Ctrl+D=選択解除
          </p>

          {/* ツールプロパティ: いま選んでいる筆の質感を直接いじる。値は描いた op に焼き込まれるので、
              ここを後から変えても、既に描いた線の見た目は変わらない（履歴と絵が食い違わない）。 */}
          <div className="tool-props">
            <div className="tool-props-head">
              <span>ツールプロパティ{isPaintTool(tool) ? ` · ${toolLabel}` : ''}</span>
              {isPaintTool(tool) && (
                <button
                  className="icon-btn"
                  title={`${toolLabel} の質感を初期プリセットに戻す`}
                  disabled={sameSettings(brushSet, BRUSH_DEFAULTS[brushType])}
                  onClick={resetBrushTuning}
                >
                  ↺ リセット
                </button>
              )}
            </div>
            {isPaintTool(tool) ? (
              <>
                {BRUSH_SETTING_FIELDS.map((f) => {
                  // ぼかし>0 のときは減衰曲線が縁を決めるので「縁の締まり」は効かない。
                  const disabled = f.key === 'edge' && brushSet.soft > 0;
                  return (
                    <label className={`field tool-prop${disabled ? ' off' : ''}`} key={f.key} title={f.hint}>
                      <span>
                        {f.label} {brushSet[f.key]}
                      </span>
                      <input
                        type="range"
                        min={f.min}
                        max={f.max}
                        step={f.step}
                        value={brushSet[f.key]}
                        disabled={disabled}
                        onChange={(e) => setBrushField(f.key, Number(e.target.value))}
                      />
                    </label>
                  );
                })}
                <p className="hint">
                  設定はこれから描く線に適用されます。
                  すでに描いた線の見た目は変わりません。
                </p>
              </>
            ) : (
              <p className="hint">
                調整できる質感を持つのは筆（Brush / Gペン / 鉛筆 / エア）だけです。
              </p>
            )}
          </div>
        </Section>

        <Section title="CANVAS" defaultOpen={false}>
          <div className="canvas-size-current">
            現在: <b>{width}×{height}</b>{' '}
            <span className="muted">({((width * height) / 1_000_000).toFixed(1)} MP)</span>
          </div>
          <div className="canvas-size-row">
            <input
              type="number"
              min={1}
              max={MAX_CANVAS_DIM}
              value={wDraft}
              onChange={(e) => setWDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyCanvasSize()}
              title="幅 (px)"
            />
            <span className="muted">×</span>
            <input
              type="number"
              min={1}
              max={MAX_CANVAS_DIM}
              value={hDraft}
              onChange={(e) => setHDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applyCanvasSize()}
              title="高さ (px)"
            />
            <button onClick={applyCanvasSize} title="このサイズに変更（内容は保持）">
              Apply
            </button>
          </div>
          <div className="btn-group">
            {CANVAS_PRESETS.map((p) => (
              <button
                key={p.label}
                className={width === p.w && height === p.h ? 'active' : ''}
                onClick={() => {
                  setWDraft(String(p.w));
                  setHDraft(String(p.h));
                  changeCanvasSize(p.w, p.h);
                }}
                title={`${p.w}×${p.h}（${((p.w * p.h) / 1_000_000).toFixed(1)} MP）`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="hint">
            サイズ変更は非破壊（内容は保持。縮小=枠外に隠れ、拡大=再び現れる）。キャンバス右辺・下辺の
            ハンドルを掴んで引っ張っても変えられます。上限 {MAX_CANVAS_DIM}px/辺。高解像度ほどメモリを
            食います（1レイヤ ≈ 幅×高さ×4 byte。例: 8192² ≈ 256MB/枚）。
          </p>
        </Section>

        <Section title="COLOR" defaultOpen>
          {/* メイン / サブ / 透明 の3枠。透明は色ではなく「アルファを削る」指定なので、
              選ぶといま持っている筆がその質感のまま消しゴムとして働く。 */}
          <div className="color-slots">
            <button
              className={`color-slot${colorSlot === 'main' ? ' active' : ''}`}
              style={{ background: mainColor }}
              onClick={() => setColorSlot('main')}
              title="メインカラー（X でサブと切り替え）"
            >
              <span className="color-slot-label">メイン</span>
            </button>
            <button
              className={`color-slot${colorSlot === 'sub' ? ' active' : ''}`}
              style={{ background: subColor }}
              onClick={() => setColorSlot('sub')}
              title="サブカラー（X でメインと切り替え）"
            >
              <span className="color-slot-label">サブ</span>
            </button>
            <button
              className={`color-slot color-slot-transparent${
                colorSlot === 'transparent' ? ' active' : ''
              }`}
              onClick={() => setColorSlot('transparent')}
              title="透明色（C で切り替え）: 色を置かずにアルファを削る。いまの筆がその質感のまま消しゴムになる"
            >
              <span className="color-slot-label">透明</span>
            </button>
          </div>
          <p className="hint">
            X=メイン⇄サブ／C=透明⇄色。透明は
            {transparentInk ? `いま有効（${toolLabel}がその質感のまま消しゴムになります）` : '色ではなく透過を塗ります'}。
          </p>
          {/* ピッカーが編集するのは「いま選んでいる色枠」。透明を選んだまま色を触ったら色枠へ戻す。 */}
          <ColorPicker color={color} onChange={setColor} />
        </Section>

        <Section title="ADJUST" defaultOpen={false}>
          <div className="field">
            <span>brightness</span>
            <div className="btn-group">
              {[-40, -10, 10, 40].map((d) => (
                <button key={d} onClick={() => adjustBrightness(d)}>
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>hue</span>
            <div className="btn-group">
              {[-45, -15, 15, 45].map((d) => (
                <button key={d} onClick={() => adjustHue(d)}>
                  {d > 0 ? `+${d}°` : `${d}°`}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">対象レイヤへの相対調整。1クリック = 1操作として記録されます。</p>
        </Section>

        <Section title="TRANSFORM" defaultOpen={false}>
          <div className="tool-row">
            <button onClick={() => applyRotate90(-1)} title="左に90°回転">
              ⟲ 90°
            </button>
            <button onClick={() => applyRotate90(1)} title="右に90°回転">
              ⟳ 90°
            </button>
            <button onClick={() => applyFlip('h')} title="左右反転">
              Flip H
            </button>
            <button onClick={() => applyFlip('v')} title="上下反転">
              Flip V
            </button>
          </div>
          <p className="hint">
            ワンクリック変形（アクティブレイヤー、中心基準）。自由な移動・拡大縮小・回転は
            Transform ツール（V）でキャンバス上の枠をドラッグ。
          </p>
        </Section>
      </FloatWindow>

      <FloatWindow
        id="nrc-layers"
        title="Layers"
        defaultPos={{ right: 12, top: 12 }}
        className="float-layers"
      >
        <Section title="LAYERS" defaultOpen>
          {/* 作る操作。落とし所は「最上位」または「選んでいる行の隣」で、対象を選ばなくても押せる。 */}
          <div className="tool-group-label">追加</div>
          <div className="layer-ops">
            <LayerOpButton
              icon="layerAdd"
              label="レイヤー"
              title="新しいレイヤーを最上位に追加して、それを選択・描き先にする"
              onClick={addLayer}
            />
            <LayerOpButton
              icon="folderAdd"
              label="フォルダ"
              title="空のフォルダを最上位に追加（行を持ち上げて中央へ落とすと収納できる）"
              onClick={addFolder}
            />
            <LayerOpButton
              icon="variantAdd"
              label="差分追加"
              title="選んでいる行の横に、空の差分を増やす（＝そのスロットに横軸を持たせる）。横に並ぶ差分は同時には存在せず、行を左右にスライドして切り替える"
              onClick={() => addVariant(false)}
              disabled={!opTarget()}
            />
            <LayerOpButton
              icon="variantCopy"
              label="差分複製"
              title="選んでいる行の内容を複製して、その複製を新しい差分として横に増やす（案A を少し変えた案B を作る用）"
              onClick={() => addVariant(true)}
              disabled={!opTarget()}
            />
            <LayerOpButton
              icon="slotEmpty"
              label="空スロット"
              title="選んでいる行に「何も無い」という差分を足す。これを選べばその行は絵に出ません（＝「非表示にして残す」の置き換え）。状態の所属先にもなるので、「ver1 ではここは無し」を関係として持てます"
              onClick={addEmptySlot}
              disabled={!opTarget()}
            />
          </div>
          {/* 選んだ 1 行に効く操作。行の中にはボタンを置かず（行は掴む・眺める場所にしておきたい）、
              「どの行に効くのか」は見出しに名前を出して示す。 */}
          {(() => {
            const t = opTarget();
            const node = t?.node;
            const leaf = t?.leaf ?? null;
            const stack = t?.stack ?? null;
            // 表示/非表示は行（スロット）に効かせる。中身ごとの非表示は持たせない。
            const visTarget = t ? visibilityTarget(t) : null;
            // 空スロットは「何も無い」を表す中身なので、中身をいじる操作は効かない。
            const isEmpty = !!node && isEmptySlot(node);
            // クリップは「解除」も含めてトグル。まだ付いていないのに下地が無い時だけ押せない。
            const clipEnabled = !!leaf && (!!leaf.clipped || canClip(leaf));
            const canDelete = !!node && leafCount() - collectLeafIds(node).length >= 1;
            const isVariant = !!stack;
            return (
              <>
                <div className="tool-group-label">
                  選択中
                  {node ? (
                    <span className="layer-ops-target" title="上のボタンはこの行に効きます">
                      {isGroup(node) ? '📁 ' : ''}
                      {node.name}
                      {isVariant ? '（差分）' : ''}
                    </span>
                  ) : (
                    <span className="muted">なし</span>
                  )}
                </div>
                {/* 選択（＝ボタンの効き先）と描き先が食い違うのは、フォルダやスロットを選んだ
                    ときだけ。その間どこに筆が乗るのか分からなくならないよう、食い違うときだけ出す。 */}
                {node && node.id !== activeLayerId && (
                  <div className="layer-draw-target">
                    描き先
                    <span title="フォルダは描き先になれません。筆・消しゴム・塗りはこの行に効きます（行の「描」印と同じ）">
                      {getNode(session.state, activeLayerId)?.name ?? '—'}
                    </span>
                  </div>
                )}
                <div className="layer-ops">
                  <LayerOpButton
                    icon={visTarget?.visible === false ? 'hidden' : 'visible'}
                    label={visTarget?.visible === false ? '非表示' : '表示'}
                    title={
                      !visTarget
                        ? '行を選んでください'
                        : visTarget.visible
                          ? `表示中（押すと${isVariant ? 'この行ごと' : ''}絵から外す）${
                              isVariant
                                ? '。これは一時的に行を消す操作で、全状態に効きます。「この状態では出さない」は空スロットに所属させて表します'
                                : ''
                            }`
                          : '非表示（押すと絵に戻す）'
                    }
                    onClick={() => visTarget && toggleVisibility(visTarget)}
                    disabled={!visTarget}
                    on={visTarget?.visible === false}
                    tone="off"
                  />
                  <LayerOpButton
                    icon="blendMultiply"
                    label="乗算"
                    title={
                      !node
                        ? '行を選んでください'
                        : isEmpty
                          ? '空スロットには合成方法がありません（何も出ないので）'
                          : node.blendMode === 'multiply'
                            ? '乗算で合成中（押すと通常合成に戻す）'
                            : `通常合成（押すと乗算に。下の色に掛かるので影や線画向き${
                                isGroup(node) ? '。フォルダなら中身をまとめて掛ける' : ''
                              }）`
                    }
                    onClick={() => node && toggleMultiply(node)}
                    disabled={!node || isEmpty}
                    on={node?.blendMode === 'multiply'}
                    tone="mul"
                  />
                  <LayerOpButton
                    icon="clip"
                    label="クリップ"
                    title={
                      !leaf
                        ? 'レイヤーを選んでください（フォルダはクリップできません）'
                        : leaf.clipped
                          ? 'クリッピングを解除する'
                          : clipEnabled
                            ? '下のレイヤーにクリップ (clipping mask): 下地のある所にだけ描いた色が乗る'
                            : '直下にレイヤーが無いためクリップできません'
                    }
                    onClick={() => leaf && toggleClip(leaf)}
                    disabled={!clipEnabled}
                    on={!!leaf?.clipped}
                    tone="clip"
                  />
                  <LayerOpButton
                    icon="mergeDown"
                    label="下と結合"
                    title={
                      node && canMergeDown(node)
                        ? '下のレイヤーと統合 (merge down): 2枚を1枚に焼き付ける'
                        : '下に統合できるレイヤーがありません（フォルダ・差分の中は対象外）'
                    }
                    onClick={() => node && mergeDown(node)}
                    disabled={!node || !canMergeDown(node)}
                  />
                  <LayerOpButton
                    icon="layerClear"
                    label="全消去"
                    title={
                      leaf
                        ? '中身を全部消す（レイヤー自体は残る。Undo で戻せます）'
                        : 'レイヤーを選んでください（フォルダは中身ごとの消去に未対応）'
                    }
                    onClick={() => leaf && clearLayerContent(leaf)}
                    disabled={!leaf}
                  />
                  <LayerOpButton
                    icon="layerDelete"
                    label="削除"
                    title={
                      !node
                        ? '行を選んでください'
                        : !canDelete
                          ? 'これ以上消すとレイヤーが 0 枚になります'
                          : isVariant
                            ? 'この差分を削除（残り1つになったら横軸は解除）'
                            : isGroup(node)
                              ? 'このフォルダを中身ごと削除'
                              : 'このレイヤーを削除'
                    }
                    onClick={() => {
                      if (!node) return;
                      if (stack) removeVariant(stack, node);
                      else deleteLayer(node);
                    }}
                    disabled={!node || !canDelete}
                  />
                </div>
              </>
            );
          })()}
          {/* 読み込み・書き出しはレイヤー構造をいじる操作ではない（PSD に至ってはドキュメントごと
              差し替わる）ので、レイヤー操作とは列を分けて置く。 */}
          <div className="tool-group-label">読み込み・書き出し</div>
          <div className="tool-row">
            <button
              onClick={() => imageInputRef.current?.click()}
              title="画像ファイルを新規レイヤーとして読み込む（キャンバスに収まるよう縮小して中央に置く）"
            >
              Import
            </button>
            <button
              onClick={() => psdInputRef.current?.click()}
              title="PSD を読み込む（PSD 実寸でキャンバスを作成し新規ドキュメントとして開く。レイヤー/フォルダ/クリッピングを保持。ブレンドモード/レイヤーマスクは非対応）"
            >
              PSD
            </button>
            <button onClick={exportPng} title="現在の合成を PNG 保存">
              PNG
            </button>
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importImage(f);
              e.target.value = '';
            }}
          />
          <input
            ref={psdInputRef}
            type="file"
            accept=".psd,image/vnd.adobe.photoshop"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importPsd(f);
              e.target.value = '';
            }}
          />
          {(() => {
            // 選んでいる行 1 つに対する不透明度スライダー（他の操作ボタンと効き先を揃える。
            // フォルダを選べばフォルダ全体の不透明度になる）。空スロットは何も出ないので対象外。
            const raw = opTarget()?.node;
            const al = raw && !isEmptySlot(raw) ? raw : null;
            const v = al ? (opacityDraft?.id === al.id ? opacityDraft.v : al.opacity) : 1;
            return (
              <div className="layer-active-opacity">
                <span className="muted">不透明度</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={v}
                  disabled={!al}
                  onChange={(e) => al && onOpacityInput(al, Number(e.target.value))}
                  onPointerUp={() => al && commitOpacity(al)}
                  onBlur={() => al && commitOpacity(al)}
                  onKeyUp={() => al && commitOpacity(al)}
                />
                <span className="layer-opacity-val">{Math.round(v * 100)}%</span>
              </div>
            );
          })()}
          {/* 状態（ver1 / ver2）。名札がレールの頭で、押すとその状態が出る。
              名札の色と、リストの左を走る線の色が対応している（名前の幅はレール間隔に収まらないので、
              位置ではなく色で対応させる）。 */}
          <div className="tool-group-label">
            状態
            <span className="muted"> — 別の行にいる差分どうしの関係</span>
          </div>
          <div className="state-bar">
            {stateList.map((st, si) => {
              const live = liveAttachmentsOf(session.state, st.id);
              const on = stateSatisfied(session.state, st.id);
              return (
                <span key={st.id} className={`state-chip${on ? ' on' : ''}`}>
                  <span className="state-swatch" style={{ background: railColor(si) }} />
                  {editingStateId === st.id ? (
                    <input
                      className="state-name-input"
                      autoFocus
                      value={editingStateName}
                      onChange={(e) => setEditingStateName(e.target.value)}
                      onBlur={() => commitStateRename(st)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitStateRename(st);
                        else if (e.key === 'Escape') setEditingStateId(null);
                      }}
                    />
                  ) : (
                    <button
                      className="state-apply"
                      onClick={() => applyStateNow(st)}
                      onDoubleClick={() => startStateRename(st)}
                      title={
                        live.length === 0
                          ? `${st.name} にはまだ何も所属していません（行の左のレールを押してくっつけます）`
                          : on
                            ? `${st.name} がいまそのまま出ています（所属 ${live.length} 行）／ダブルクリックで名称変更`
                            : `押すと ${st.name} を出す：所属している ${live.length} 行が一斉に切り替わります（スロットが 1 つの行は動きません）／ダブルクリックで名称変更`
                      }
                    >
                      {st.name}
                      <span className="state-count">{live.length}</span>
                    </button>
                  )}
                  <button
                    className="state-del"
                    onClick={() => deleteState(st)}
                    title="この状態を消す（付いていた所属が一斉に外れるだけで、スロットは 1 つも消えません）"
                  >
                    ✕
                  </button>
                </span>
              );
            })}
            <button className="state-add" onClick={addState} title="状態を作る">
              ＋ 状態
            </button>
          </div>
          {stateList.length > 0 && !stateList.some((s) => stateSatisfied(session.state, s.id)) && (
            // 「どの状態でもない」を言えるようにする。名前で手管理していると気づけない種類のズレで、
            // 実データでも影の差分が両方とも非表示のまま保存されていた。
            <p className="state-note">
              いまの絵は<b>どの状態でもありません</b>（どこかの行が、状態の指すスロットと違うものを出しています）。
            </p>
          )}
          {/* ここから下だけがスクロールする。上の操作パネル（追加 / 選択中 / 不透明度）は
              リストがどれだけ伸びても同じ位置に留まり、行を選んだまま押しに行ける。 */}
          <div className="layer-scroll">
            <div
              className="layer-tree"
              ref={layerTreeRef}
              style={{ paddingLeft: railGutterW || undefined }}
            >
              {renderStateRails(stateList)}
              <ul className="layer-list">
                {session.state.layers
                  .slice()
                  .reverse()
                  .map((n) => renderNode(n, 0, session.state.layers))}
              </ul>
            </div>
          </div>
        </Section>
      </FloatWindow>
    </div>
  );
}
