import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
} from '../types';
import type { EditorSession } from '../session';
import { statesEqual } from '../engine/compare';
import { applyOperation } from '../engine/operation';
import { Replayer } from '../backend/replayer';
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
  type TransformParams,
} from '../engine/operations';
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
import { describeOp } from './opLabel';
import { ColorPicker } from './ColorPicker';
import { ConfirmButton } from './ConfirmButton';
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
  | 'transform'
  | 'inspect';

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
      {
        id: 'inspect',
        label: '履歴しらべ',
        key: 'Q',
        icon: 'inspect',
        hint: '矩形で囲った範囲に関わる操作を履歴からハイライト（選択範囲ではない）',
      },
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
const LAYER_THUMB_W = 34;
const LAYER_THUMB_H = 26;

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
// CSS の .vc-chip の幅 + gap と一致させること。
const VARIANT_PITCH_PX = 40;

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
}: {
  icon: ToolIconName;
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /** 押しっぱなしに見せる（クリッピングが効いている間など）。 */
  on?: boolean;
}) {
  return (
    <button
      className={`layer-op${on ? ' on' : ''}`}
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
  highlightRegion,
  onRegionSelect,
  onLoadPsdDocument,
}: {
  session: EditorSession;
  width: number;
  height: number;
  version: number;
  onEdit: () => void;
  highlightRegion: BBox | null;
  onRegionSelect: (bbox: BBox) => void;
  onLoadPsdDocument: (w: number, h: number, ops: readonly Operation[]) => void;
}) {
  // Replayer は「元サイズ（session 生成時のサイズ）」の初期状態から log を replay する。キャンバス
  // リサイズは log 上の canvasSize op で表現されるので、元サイズから replay すれば現在サイズへ到達し、
  // Verify（replay とライブ状態のビット一致）が成立する。現在の width/height（プロップ）ではなく
  // 不変の session.width/height を使うのが肝心（現在サイズで作り直すと base レイヤ寸法がずれて Verify 失敗）。
  const replayerRef = useRef<Replayer | null>(null);
  if (!replayerRef.current) replayerRef.current = new Replayer(session.width, session.height);

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
  const selectRef = useRef<{ startX: number; startY: number } | null>(null);
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
  // 差分を「覗き見」している状態。state は変えず、いまどの差分が出るかだけを差し替える
  // （離す/クリックで初めて 1 op として確定＝見比べても履歴が汚れない）。
  const [variantPeek, setVariantPeek] = useState<{ stackId: string; index: number } | null>(null);
  const variantPeekRef = useRef<{ stackId: string; index: number; baseIndex: number } | null>(null);
  // 左右スライド中のスロット（カルーセルを出す対象）。
  const [swipingStackId, setSwipingStackId] = useState<string | null>(null);
  // カルーセルの帯。指の動きに毎フレーム追従させるので、再レンダーを挟まず transform を直接書く。
  const carouselTrackRef = useRef<HTMLDivElement>(null);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; msg: string } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [zoom, setZoom] = useState(1);
  // パン(視点移動)は scroll ではなく transform で行う（キャンバスが画面に収まっていても動かせる）。
  // pan = キャンバス左上のビューポート左上からのオフセット(px)。
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [opacityDraft, setOpacityDraft] = useState<{ id: string; v: number } | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  // レイヤー D&D 中のドロップ位置ヒント（対象ノード id と、その上/下/中/左/右への挿入）。
  const [dropHint, setDropHint] = useState<{ id: string; pos: DropPos } | null>(null);
  // 持ち上げ中の行（null = 掴んでいない）。ゴーストの表示と、持ち上がった行の見た目に使う。
  const [dragGhost, setDragGhost] = useState<{ id: string; name: string } | null>(null);
  // キャンバスサイズ入力の下書き（Apply で確定）。remount 時に現在サイズで初期化される。
  const [wDraft, setWDraft] = useState(String(width));
  const [hDraft, setHDraft] = useState(String(height));
  // ドラッグ中の不透明度プレビュー（再レンダーを介さず合成へ反映するため ref）。
  const opacityPreviewRef = useRef<{ layerId: string; opacity: number } | null>(null);

  const previewing = histIndex !== null;
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

  const drawHighlight = (c: HTMLCanvasElement) => {
    if (!highlightRegion || highlightRegion.w <= 0 || highlightRegion.h <= 0) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = '#ffd60a';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      highlightRegion.x + 0.5,
      highlightRegion.y + 0.5,
      Math.max(1, highlightRegion.w - 1),
      Math.max(1, highlightRegion.h - 1),
    );
    ctx.restore();
  };

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
    if (!c || previewing) return;
    compositeToCanvas(c, displayState());
    drawHighlight(c);
    if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
  };

  // 部分再描画: 変化した矩形 region（キャンバス座標）だけを合成し直す。全面 flatten を避けるので、
  // 4K 以上でも編集の確定・不透明度変更・undo/redo が軽い。region が無い/広すぎる場合は全面にフォールバック。
  const repaintRegion = (region: BBox | null) => {
    const c = canvasRef.current;
    if (!c || previewing) return;
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
      drawHighlight(c);
      if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
      return;
    }
    // 領域が広いと windowing のオーバーヘッドが勝るので素直に全面。
    if (rw * rh >= width * height * 0.6) return repaint();
    compositeRegionToCanvas(c, displayState(), x0, y0, rw, rh);
    drawHighlight(c);
    if (tool === 'transform' && activeContentBBox) drawXformBox(c, bboxCorners(activeContentBBox));
  };

  // ブラシ/消しゴムの確定描画は全画面 flatten で、キャンバスが大きい・レイヤが多いほど重い（数十ms）。
  // これをストロークごと（pointer up 毎）に走らせると 1 本ごとに固まる。連続描画中はプレビュー最終
  // フレームが表示を担えるので、確定 flatten は「少しアイドルしてから 1 回だけ」に間引く（バーストを 1
  // 回にまとめる）。session.state は即時正しいので board/verify 等には影響しない（表示だけ 90ms 遅延）。
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

  // 新しいドキュメント（別 session）になったときだけ Replayer を作り直す。session.width/height は
  // その doc の元サイズで不変なので、リサイズ（canvasSize op）では作り直さない。
  useEffect(() => {
    replayerRef.current = new Replayer(session.width, session.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // マウント時・編集後(version)・選択ハイライト変更時・サイズ変更時に再描画。
  // ブラシ確定バースト中（deferExactRef）はプレビューが表示を担うので、全画面 flatten は間引く。
  // 編集ハンドラが markDirty で領域を指定していれば、その矩形だけを部分再描画する（未指定なら全面）。
  useEffect(() => {
    if (deferExactRef.current) return;
    flushDirtyRepaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, highlightRegion, width, height]);

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

  // checkout 等でアクティブレイヤが存在しなくなったら現在状態の active に合わせる。
  useEffect(() => {
    if (!getNode(session.state, activeLayerId)) {
      setActiveLayerId(session.state.activeLayerId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const doUndo = () => {
    if (previewing) return;
    if (session.undo()) {
      markDirty(session.lastDirtyRegion ?? 'full'); // 変化領域が分かれば部分再描画
      onEdit(); // version 効果が flushDirtyRepaint（部分/全面）を実行する
    }
  };

  const doRedo = () => {
    if (previewing) return;
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
      case 'q': case 'Q': setTool('inspect'); break;
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
      drawHighlight(c);
      return;
    }
    compositeToCanvas(c, applyOperation(session.state, strokeOp(strokes)));
    drawHighlight(c);
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

  const drawSelectionPreview = (x0: number, y0: number, x1: number, y1: number) => {
    const c = canvasRef.current!;
    compositeToCanvas(c, session.state);
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.strokeStyle = '#56ccf2';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    ctx.restore();
  };

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
      loops: previewing ? [] : selectionOutline(),
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

  // 選択の変化・ズーム・履歴閲覧の切り替え・キャンバスサイズ変更でオーバーレイを描き直す
  // （canvas の width/height を変えると中身が消えるので、サイズ変更後も描き直しが要る）。
  useEffect(() => {
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMask, zoom, previewing, width, height]);

  // 点線を流す。選択が無いとき／履歴閲覧中は止める（無駄な描画をしない）。
  // 1 ティックで破線 1 本ぶんの 1/ANTS_STEPS だけ進み、2×ANTS_STEPS ティックで元の見た目に戻る。
  useEffect(() => {
    if (previewing || !selectionMask) return;
    const t = window.setInterval(() => {
      antsPhaseRef.current = (antsPhaseRef.current + 1) % (ANTS_STEPS * 2);
      drawOverlay();
    }, 70);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMask, previewing]);

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
    if (!la || previewing) {
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
    if (previewing || !session.state.selection) return;
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
    if (previewing) return;
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
    drawHighlight(c); // 外周だけの軽い上書き（clip した矩形が横切っても全体を描き直して復元）。
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
    if (previewing) return;
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
    } else if (tool === 'inspect') {
      selectRef.current = { startX: pt.x, startY: pt.y };
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
    if (tool === 'transform' && !xformRef.current && !previewing) {
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
    } else if (selectRef.current) {
      const pt = getPoint(e);
      drawSelectionPreview(selectRef.current.startX, selectRef.current.startY, pt.x, pt.y);
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
    } else if (selectRef.current) {
      const pt = getPoint(e);
      const x0 = selectRef.current.startX;
      const y0 = selectRef.current.startY;
      selectRef.current = null;
      const bbox: BBox = {
        x: Math.min(x0, pt.x),
        y: Math.min(y0, pt.y),
        w: Math.abs(pt.x - x0),
        h: Math.abs(pt.y - y0),
      };
      if (bbox.w > 2 && bbox.h > 2) onRegionSelect(bbox);
      repaint();
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
    if (previewing) return;
    const layer = getActiveLayer();
    const region = layer ? layerContentBBox(layer) : undefined;
    if (region) markDirty(region);
    session.apply(createBrightnessOp(activeLayerId, delta, width, height, region));
    onEdit();
  };

  const adjustHue = (shift: number) => {
    if (previewing) return;
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
    if (previewing) return;
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    applyTransformMatrix(buildMatrix(1, dir * 90, pivot), layer);
  };

  const applyFlip = (axis: 'h' | 'v') => {
    if (previewing) return;
    const layer = getActiveLayer();
    const pivot = layer ? pivotOf(layer) : null;
    if (!layer || !pivot) return;
    const a = axis === 'h' ? -1 : 1;
    const d = axis === 'v' ? -1 : 1;
    applyTransformMatrix({ a, b: 0, c: 0, d, e: pivot.x - a * pivot.x, f: pivot.y - d * pivot.y }, layer);
  };

  const addLayer = () => {
    if (previewing) return;
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
    if (previewing) return;
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
    if (previewing) return;
    try {
      const buffer = await file.arrayBuffer();
      // ag-psd は大きいので初回インポート時だけ動的ロード（初期表示を軽く保つ）。
      const { buildPsdImportOps } = await import('./psdImport');
      const { ops, width: w, height: h, leafCount, groupCount, clipCount, scaled, psdWidth, psdHeight } =
        buildPsdImportOps(buffer, MAX_CANVAS_DIM);
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
          (scaled ? '（上限を超えるため縮小）' : ''),
      );
    } catch (err) {
      console.error(err);
      alert('PSD の読み込みに失敗しました。対応していない形式の可能性があります。');
    }
  };

  // キャンバス（アートボード）サイズを変更する。非破壊: レイヤーの buffer/offset は触らず、クリップ範囲
  // （アートボード矩形）だけを canvasSize op で変える。縮小=枠外に隠れる / 拡大=再び現れる（内容は消えない）。
  // op として log に積むので Undo でき、Verify(replay 一致) も保たれる。
  const changeCanvasSize = (w: number, h: number) => {
    if (previewing) return;
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
    if (previewing) return;
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

  const toggleVisibility = (n: LayerNode) => {
    if (previewing) return;
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
    if (previewing || isGroup(n)) return;
    session.apply(createSetLayerClippingOp(n.id, !n.clipped, nodeRegion(n)));
    onEdit();
    repaint();
  };

  const deleteLayer = (n: LayerNode) => {
    if (previewing) return;
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
    if (previewing) return;
    const target = getNode(session.state, activeLayerId);
    if (!target) return;
    const stack = getVariantStackOf(session.state, activeLayerId);
    const count = stack ? stack.children.length : 1;
    const name = copy ? `${target.name} copy` : `Var ${count + 1}`;
    markDirty('full');
    session.apply(
      createAddVariantOp(target.id, stack?.id ?? genId('variants'), genId('layer'), name, copy),
    );
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  // いま出ている差分を捨てる。残り 1 つになったら横軸は解け、素のレイヤーに戻る。
  const removeVariant = (stack: LayerGroup, variant: LayerNode) => {
    if (previewing) return;
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

  // アクティブレイヤーの内容を全消去（透明化）。1操作として記録され Undo 可能。
  const clearActiveLayer = () => {
    if (previewing) return;
    const layer = getActiveLayer();
    if (!layer) return;
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
    if (previewing || !canMergeDown(n)) return;
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
    if (previewing) return;
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
    if (previewing || dragIdRef.current) return; // 並べ替えドラッグ中に覗き見が割り込まないように
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
    if (previewing || index === variantIndexOf(stack) || index < 0) {
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
    } else if (isGroup(tn)) {
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
    if (previewing || !dragged) return;
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
    if (previewing || draggedId === targetId) return;
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
    if (previewing) return;
    markDirty('full'); // 差分の入れ替えは絵の全面が変わりうる
    session.apply(createMoveAsVariantOp(draggedId, targetId, genId('vstack'), side));
    setActiveLayerId(session.state.activeLayerId);
    onEdit();
  };

  // 既存のレイヤーをスロットへ落として「そのスロットの差分」にする。
  // 落としたものをそのまま表示中の差分にするので、結果が即座に見える。
  const dropAsVariant = (draggedId: string, stack: LayerGroup) => {
    if (previewing) return;
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
    if (previewing) return;
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
    if (previewing) return;
    session.apply(createAddGroupOp(genId('group'), `Folder ${session.state.layers.length}`));
    onEdit();
    repaint();
  };

  // レイヤー名クリック: グループは開閉、リーフはアクティブ化。
  const onLayerClick = (n: LayerNode) => {
    // 開いたスロットの中で控えの差分をクリックしたら、それをそのスロットに出す
    // （左右スライドと同じことを、一覧から直接選べるようにする）。
    const inStack = getVariantStackOf(session.state, n.id);
    if (inStack && activeVariant(inStack)?.id !== n.id) {
      const at = inStack.children.findIndex((c) => c.id === n.id);
      if (at >= 0) {
        chooseVariant(inStack, at);
        return;
      }
    }
    if (isGroup(n)) {
      toggleCollapse(n);
      return;
    }
    setActiveLayerId(n.id);
  };

  const onOpacityInput = (n: LayerNode, v: number) => {
    setOpacityDraft({ id: n.id, v });
    opacityPreviewRef.current = { layerId: n.id, opacity: v };
    if (previewing) return;
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
  // 合成結果に影響する要素の署名（グループサムネは子の可視/不透明度/クリップ/内容で決まる）。
  const renderSig = (n: LayerNode): string =>
    isGroup(n)
      ? `g${n.visible ? 1 : 0}.${Math.round(n.opacity * 100)}[${n.children.map(renderSig).join(',')}]`
      : `l${bufId(n.buffer)}@${n.offsetX},${n.offsetY}.${n.visible ? 1 : 0}.${Math.round(
          n.opacity * 100,
        )}.${n.clipped ? 1 : 0}`;
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
    const slotId = stack ? stack.id : node.id;
    const grp = isGroup(node) ? node : null;
    const leaf = grp ? null : (node as Layer);
    const editing = editingLayerId === node.id;
    const active = !grp && node.id === activeLayerId;
    const disableDelete = previewing || leafCount() - collectLeafIds(node).length < 1;
    const dropCls = dropHint?.id === slotId ? ` drop-${dropHint.pos}` : '';
    // この行が「開いたスロットの中の1枚」なら、その親スタック（＝取り出し元）。
    const inStack = stack ? undefined : getVariantStackOf(session.state, n.id);
    const isShownVariant = inStack ? activeVariant(inStack)?.id === n.id : false;
    return (
      <li
        key={slotId}
        className={`layer-item ${grp ? 'is-group' : ''} ${active ? 'active' : ''}${
          leaf?.clipped ? ' is-clipped' : ''
        }${stack ? ' has-variants' : ''}${
          variantPeek?.stackId === slotId ? ' peeking' : ''
        }${inStack ? ' is-variant' : ''}${isShownVariant ? ' is-shown-variant' : ''}${
          dragGhost?.id === slotId ? ' lifted' : ''
        }${dropCls}`}
      >
        <div
          className="layer-head"
          data-id={slotId}
          style={{ paddingLeft: 4 + depth * 12 }}
          onPointerDown={(e) => onRowPointerDown(n, e)}
          onPointerMove={onRowPointerMove}
          onPointerUp={onRowPointerUp}
          onPointerCancel={onRowPointerUp}
          // 長押し中にコンテキストメニューが割り込むと持ち上げが中断されるので抑止する。
          onContextMenu={(e) => e.preventDefault()}
          // 開いた一覧の差分行も、サムネイル帯と同じくホバーで確認・クリックで確定にする。
          onPointerEnter={
            inStack ? () => peekVariant(inStack, inStack.children.indexOf(n)) : undefined
          }
          onPointerLeave={inStack ? clearVariantPeek : undefined}
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
          {/* 開閉の枠は 1 つだけ（行が横に伸びると名前が潰れるため）。
              スロット行はスロットの開閉を優先する: 開くと中の差分が縦に並び、
              1 枚ずつ掴んで外へ出せる（＝横軸の分解）。 */}
          {stack ? (
            <button
              className="icon-btn"
              title={
                stack.collapsed
                  ? `差分 ${stack.children.length} 枚を開く（1 枚ずつ掴んで外へ出せます）`
                  : '差分を畳む'
              }
              onClick={() => toggleCollapse(stack)}
            >
              {stack.collapsed ? '▸' : '▾'}
            </button>
          ) : grp ? (
            <button
              className="icon-btn"
              title={grp.collapsed ? '展開' : '折りたたみ'}
              onClick={() => toggleCollapse(grp)}
            >
              {grp.collapsed ? '▸' : '▾'}
            </button>
          ) : inStack ? null : (
            <span className="layer-indent" />
          )}
          {/* 差分行では表示/非表示を出さない。控えの差分はそもそも絵に載らず、出ている 1 枚の
              表示切替はスロット行が持っているため（同じ操作を二重に置くと名前の幅が無くなる）。 */}
          {!inStack && (
            <button
              className="icon-btn"
              title={node.visible ? '表示中（クリックで非表示）' : '非表示（クリックで表示）'}
              disabled={previewing}
              onClick={() => toggleVisibility(node)}
            >
              {node.visible ? '👁' : '🚫'}
            </button>
          )}
          <img
            className="layer-thumb"
            src={layerThumb(node)}
            alt=""
            draggable={false}
            title="レイヤーの内容"
          />
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
              onClick={() => onLayerClick(node)}
              onDoubleClick={() => startRename(node)}
              title={
                inStack && !isShownVariant
                  ? 'クリックでこの差分をスロットに出す / ダブルクリックで名称変更'
                  : 'クリックで選択/開閉 / ダブルクリックで名称変更'
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
            {isShownVariant && (
              // 開いたスロットのうち、いま絵に載っている 1 枚の印。控え側は行を薄くして示すので
              // 印を出さない（行が横に伸びると名前の幅が無くなるため、目印は最小限にする）。
              <span className="variant-badge on" title="いまこのスロットに出ている差分" />
            )}
            {leaf && (
              <button
                className={`icon-btn${leaf.clipped ? ' on' : ''}`}
                title={
                  canClip(leaf)
                    ? '下のレイヤーにクリップ (clipping mask)'
                    : '直下にレイヤーが無いためクリップできません'
                }
                disabled={previewing || (!leaf.clipped && !canClip(leaf))}
                onClick={() => toggleClip(leaf)}
              >
                ⤵
              </button>
            )}
            {/* 差分どうしは「別の可能性」であって上下関係が無いので統合できない（canMergeDown が
                常に false）。スロット行・差分行では押せないボタンを置かず、幅を名前に回す。 */}
            {!grp && !inStack && !stack && (
              <button
                className="icon-btn"
                title="下のレイヤーと統合 (merge down)"
                disabled={previewing || !canMergeDown(node)}
                onClick={() => mergeDown(node)}
              >
                ⤓
              </button>
            )}
            <button
              className="icon-btn"
              title={stack || inStack ? 'この差分を削除（残り1つになったら横軸は解除）' : '削除'}
              disabled={disableDelete}
              onClick={() =>
                stack
                  ? removeVariant(stack, node)
                  : inStack
                    ? removeVariant(inStack, n)
                    : deleteLayer(node)
              }
            >
              🗑
            </button>
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
        {/* 開いたスロットの中身。左→右の並びをそのまま上→下に出す（帯の並びと一致させる）。
            各行は普通のレイヤー行なので、掴んで外へドラッグすればスロットから出せる＝分解になる。 */}
        {stack && !stack.collapsed && (
          <ul className="layer-list nested variants">
            <li className="variant-list-cap">
              横に並ぶ差分（この中の 1 枚だけが絵に載ります）— 掴んで外へ出すと普通のレイヤーに戻ります
            </li>
            {stack.children.map((c) => renderNode(c, depth + 1, stack.children))}
          </ul>
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

  // Reset = 履歴の畳み込み。現在の絵（レイヤー構造）は残し、log・revisions・undo だけを捨てる。
  const reset = () => {
    session.flattenToBaseline();
    setActiveLayerId(session.state.activeLayerId);
    setHistIndex(null);
    setVerify(null);
    onEdit();
    repaint();
  };

  const log = session.getLog();

  const onScrub = (k: number) => {
    if (k >= log.length) {
      setHistIndex(null);
      // setHistIndex は次レンダーで反映されるため、ここで即ライブ描画する。
      const c = canvasRef.current;
      if (c) {
        compositeToCanvas(c, session.state);
        drawHighlight(c);
      }
    } else {
      setHistIndex(k);
      compositeToCanvas(canvasRef.current!, replayerRef.current!.replay(log, k));
    }
  };

  const returnToLatest = () => {
    setHistIndex(null);
    const c = canvasRef.current;
    if (c) {
      compositeToCanvas(c, session.state);
      drawHighlight(c);
    }
  };

  const runVerify = () => {
    const replayed = replayerRef.current!.replay(session.getLog());
    const ok = statesEqual(replayed, session.state);
    setVerify({
      ok,
      msg: ok
        ? `OK — ${log.length} 操作の replay がライブ状態とビット一致`
        : 'NG — replay がライブ状態と不一致',
    });
  };

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
              canvas-stage 内なので pan に追従し、scale の外なので見た目サイズは一定。履歴閲覧中は隠す。 */}
          {!previewing && (
            <>
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
            </>
          )}
        </div>
      </div>

      <div
        ref={cursorRef}
        className={`brush-cursor ${sizeAdjust ? 'sizing' : ''}`}
        style={{
          width: size * zoom,
          height: size * zoom,
          display: showCursor && hovering && !previewing ? 'block' : 'none',
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

      {previewing && (
        <div className="preview-banner">
          履歴を閲覧中（読み取り専用）— step {histIndex}/{log.length}
          <button onClick={returnToLatest}>最新に戻る</button>
        </div>
      )}

      {/* キャンバス下部のフロートバー: ズーム + 履歴スクラブ */}
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
        <span className="cb-sep" />
        <span className="history-label">history</span>
        <input
          type="range"
          min={0}
          max={log.length}
          value={histIndex ?? log.length}
          onChange={(e) => onScrub(Number(e.target.value))}
          disabled={log.length === 0}
        />
        <span className="history-step">
          {histIndex === null ? `latest (${log.length})` : `${histIndex}/${log.length}`}
        </span>
      </div>

      <FloatWindow id="nrc-tools" title="Tools" defaultPos={{ left: 12, top: 12 }} className="float-tools">
        <Section title="TOOLS" defaultOpen>
          <div className="tool-row">
            <button onClick={doUndo} disabled={!session.canUndo() || previewing} title="Undo (Ctrl+Z)">
              <ToolIcon name="undo" size={15} /> Undo
            </button>
            <button
              onClick={doRedo}
              disabled={!session.canRedo() || previewing}
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
                disabled={previewing}
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
            L=直線 R=矩形 M=投げ縄選択 V=変形 Q=履歴しらべ／
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
                  数値は描いた瞬間に操作へ焼き込まれます。あとでここを動かしても、
                  すでに描いた線の見た目は変わりません（Undo/Verify と食い違わないため）。
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
            <button onClick={applyCanvasSize} disabled={previewing} title="このサイズに変更（内容は保持）">
              Apply
            </button>
          </div>
          <div className="btn-group">
            {CANVAS_PRESETS.map((p) => (
              <button
                key={p.label}
                className={width === p.w && height === p.h ? 'active' : ''}
                disabled={previewing}
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
                <button key={d} disabled={previewing} onClick={() => adjustBrightness(d)}>
                  {d > 0 ? `+${d}` : d}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>hue</span>
            <div className="btn-group">
              {[-45, -15, 15, 45].map((d) => (
                <button key={d} disabled={previewing} onClick={() => adjustHue(d)}>
                  {d > 0 ? `+${d}°` : `${d}°`}
                </button>
              ))}
            </div>
          </div>
          <p className="hint">対象レイヤへの相対調整。1クリック = 1操作として記録されます。</p>
        </Section>

        <Section title="TRANSFORM" defaultOpen={false}>
          <div className="tool-row">
            <button onClick={() => applyRotate90(-1)} disabled={previewing} title="左に90°回転">
              ⟲ 90°
            </button>
            <button onClick={() => applyRotate90(1)} disabled={previewing} title="右に90°回転">
              ⟳ 90°
            </button>
            <button onClick={() => applyFlip('h')} disabled={previewing} title="左右反転">
              Flip H
            </button>
            <button onClick={() => applyFlip('v')} disabled={previewing} title="上下反転">
              Flip V
            </button>
          </div>
          <p className="hint">
            ワンクリック変形（アクティブレイヤー、中心基準）。自由な移動・拡大縮小・回転は
            Transform ツール（V）でキャンバス上の枠をドラッグ。
          </p>
        </Section>

        <Section title={`LOG (${log.length})`} defaultOpen={false}>
          <div className="tool-row">
            <button onClick={runVerify} disabled={log.length === 0}>
              Verify replay
            </button>
            <ConfirmButton
              onConfirm={reset}
              idleLabel="Reset"
              armedLabel={(r) => (r > 1 ? `履歴を消す? あと${r}回` : 'あと1回で確定')}
              title="編集履歴・revisions・undo を消去し、現在の絵を1枚のベースラインに畳む（絵・レイヤー構造は残る）。3クリックで実行"
            />
          </div>
          {verify && <p className={verify.ok ? 'verify ok' : 'verify ng'}>{verify.msg}</p>}
          <ol className="op-log">
            {log.map((op, i) => (
              <li
                key={op.id}
                className={`op op-${op.klass} ${previewing && i >= histIndex! ? 'op-future' : ''}`}
              >
                <span className="op-index">{i}</span>
                <span className="op-type">{op.type}</span>
                <span className="op-desc">{describeOp(op)}</span>
              </li>
            ))}
          </ol>
        </Section>
      </FloatWindow>

      <FloatWindow
        id="nrc-layers"
        title="Layers"
        defaultPos={{ right: 12, top: 12 }}
        className="float-layers"
      >
        <Section title="LAYERS" defaultOpen>
          {/* レイヤー操作。どれもアクティブレイヤー（＝いま描いている1枚）に効く。
              各行にも同じ操作のボタンはあるが、行のボタンは幅の都合で最小限しか置けないので、
              よく使うものはここに揃えて「いまの1枚に何ができるか」を一望できるようにする。 */}
          <div className="tool-group-label">レイヤー操作</div>
          {(() => {
            const al = getActiveLayer();
            // クリップは「解除」も含めてトグル。まだ付いていないのに下地が無い時だけ押せない。
            const clipEnabled = !!al && (al.clipped || canClip(al));
            return (
              <div className="layer-ops">
                <LayerOpButton
                  icon="layerAdd"
                  label="レイヤー"
                  title="新しいレイヤーを最上位に追加して、それをアクティブにする"
                  onClick={addLayer}
                  disabled={previewing}
                />
                <LayerOpButton
                  icon="folderAdd"
                  label="フォルダ"
                  title="空のフォルダを最上位に追加（行を持ち上げて中央へ落とすと収納できる）"
                  onClick={addFolder}
                  disabled={previewing}
                />
                <LayerOpButton
                  icon="clip"
                  label="クリップ"
                  title={
                    !al
                      ? 'レイヤーを選んでください（フォルダにはクリップできません）'
                      : al.clipped
                        ? 'クリッピングを解除する'
                        : clipEnabled
                          ? '下のレイヤーにクリップ (clipping mask): 下地のある所にだけ描いた色が乗る'
                          : '直下にレイヤーが無いためクリップできません'
                  }
                  onClick={() => al && toggleClip(al)}
                  disabled={previewing || !clipEnabled}
                  on={!!al?.clipped}
                />
                <LayerOpButton
                  icon="mergeDown"
                  label="下と結合"
                  title={
                    al && canMergeDown(al)
                      ? '下のレイヤーと統合 (merge down): 2枚を1枚に焼き付ける'
                      : '下に統合できるレイヤーがありません（フォルダ・差分の中は対象外）'
                  }
                  onClick={() => al && mergeDown(al)}
                  disabled={previewing || !al || !canMergeDown(al)}
                />
                <LayerOpButton
                  icon="variantAdd"
                  label="差分追加"
                  title="アクティブレイヤーの横に、空の差分レイヤーを増やす（＝そのスロットに横軸を持たせる）。横に並ぶ差分は同時には存在せず、行を左右にスライドして切り替える"
                  onClick={() => addVariant(false)}
                  disabled={previewing}
                />
                <LayerOpButton
                  icon="variantCopy"
                  label="差分複製"
                  title="いまの内容を複製して、その複製を新しい差分として横に増やす（案A を少し変えた案B を作る用）"
                  onClick={() => addVariant(true)}
                  disabled={previewing}
                />
                <LayerOpButton
                  icon="layerClear"
                  label="全消去"
                  title="アクティブレイヤーの中身を全部消す（レイヤー自体は残る。Undo で戻せます）"
                  onClick={clearActiveLayer}
                  disabled={previewing || !al}
                />
              </div>
            );
          })()}
          {/* 読み込み・書き出しはレイヤー構造をいじる操作ではない（PSD に至ってはドキュメントごと
              差し替わる）ので、レイヤー操作とは列を分けて置く。 */}
          <div className="tool-group-label">読み込み・書き出し</div>
          <div className="tool-row">
            <button
              onClick={() => imageInputRef.current?.click()}
              disabled={previewing}
              title="画像ファイルを新規レイヤーとして読み込む（キャンバスに収まるよう縮小して中央に置く）"
            >
              Import
            </button>
            <button
              onClick={() => psdInputRef.current?.click()}
              disabled={previewing}
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
            // アクティブレイヤー1つに対する不透明度スライダー（各行から集約）。
            const al = getActiveLayer();
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
                  disabled={!al || previewing}
                  onChange={(e) => al && onOpacityInput(al, Number(e.target.value))}
                  onPointerUp={() => al && commitOpacity(al)}
                  onBlur={() => al && commitOpacity(al)}
                  onKeyUp={() => al && commitOpacity(al)}
                />
                <span className="layer-opacity-val">{Math.round(v * 100)}%</span>
              </div>
            );
          })()}
          <ul className="layer-list">
            {session.state.layers
              .slice()
              .reverse()
              .map((n) => renderNode(n, 0, session.state.layers))}
          </ul>
          <p className="hint">
            <b>行の掴み方</b>: 移動（並べ替え・フォルダ出し入れ・差分化）と、差分の左右スライドは、
            <b>向きではなく時間で分かれます</b>。<b>押してすぐ横へ動かす＝スライド</b>、
            <b>押したまま少し待つ＝持ち上がって移動</b>。⠿ を掴めば待たずに持ち上がります。
          </p>
          <p className="hint">
            <b>横軸（差分）を作る</b>: 行を持ち上げてから<b>横へずらして</b>別の行へ落とすと、
            縦に積まずにその行の<b>隣に並ぶ差分</b>になります。緑の縦棒が出た側（左/右）に入り、
            相手がまだ普通のレイヤーでも自動で横軸に化けます。持ち上げてまっすぐ縦なら並べ替えです。
            上の<b>差分追加 / 差分複製</b>でも同じものが作れます（空 / 複製の差分を増やす）。
          </p>
          <p className="hint">
            <b>横軸（差分）を切り替える</b>: ⇹ 行を<b>左右にドラッグ</b>すると並列の差分が出てきます。
            行の下のサムネイルは<b>ホバーで確認・クリックで確定</b>（ホバー中は履歴に残りません）。
            <b>, / .</b> キーでも往復できるので、A と B をパタパタ見比べられます。
            横に並ぶ差分は互いに独立で、出ている 1 枚だけが絵に載ります。
          </p>
          <p className="hint">
            <b>横軸をほどく</b>: ⇹ 行の ▸ を押すと中の差分が縦に並びます。そこから 1 枚
            <b>持ち上げて外へ</b>出せば、スロットを出て普通のレイヤーに戻ります（＝分解）。
            控えの行をクリックすればその差分に切り替わり、🗑 で 1 枚捨てられます。
            差分が 1 枚だけになった時点で横軸は自動的に解けます。
          </p>
          <p className="hint">
            持ち上げた行はフォルダの中央に落とすと収納、余白に落とすと最上位へ（ペン/タッチ可）。
            ⤵ で下のレイヤーにクリップ。
          </p>
        </Section>
      </FloatWindow>
    </div>
  );
}
