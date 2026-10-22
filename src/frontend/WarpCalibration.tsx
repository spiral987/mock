import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { KIND_LABEL, type OptResult, type PathKind, type Pt, type Tendency, type WarpField } from './warpField';
import { WARP_METHOD_LABEL, type WarpMethod } from './warpMethod';
import { genPath, resample } from './warpPaths';

/**
 * 場のゆがみ補正のキャリブレーション（描画とは分離した学習タスク）。
 *
 * 「始点・終点・経路」を指定したガイド（直線 / 円弧 / S字）を出し、なぞってもらう。
 * 経路がユーザの「理想の線」になるので、なぞった軌跡とのズレを WarpField に学習させる。
 * 1 セット終わるごとに、ズレ方の傾向を集計し、補正のかけ方（カーネル幅・強さ）を最適化する。
 * キャンバスには一切描かない。ガイドはキャンバスが見えている範囲に出す。
 * 学習中は補正をかけず、手の動きそのまま（補正なし）の線を表示する。学習に使うのも補正前の軌跡。
 *
 * 目標線・描いた線はキャンバス座標で持ち、「画面 = T + z·R(θ)·キャンバス」で写して表示する。
 *
 * 実験方式ごとの違い:
 *   方式A（キャンバス固定・視点操作なし）: 視点操作は使えない。目標線と軌跡をキャンバス座標で学習する。
 *   方式B（入力座標系固定・視点操作あり）: 視点操作（Space / 中ボタン＝移動、Z＋上下ドラッグ・
 *     Ctrl＋ホイール＝ズーム、D＋ドラッグ＝回転、ホイール＝移動）が使える。目標線と軌跡を
 *     画面の入力座標（clientX/Y）で学習する。1 本描いている間は視点が変わらないので、
 *     その時点の目標線を画面座標に写せば、手の動きと同じ座標系で比べられる。
 * 場はキャンバス座標で持つので、画面座標 ⇄ キャンバス座標を map で変換して渡す。
 * 経路は短いと局所的に極端な歪みを学習しやすいので、見えている範囲に対して長めに取る。
 */

/** area: キャンバスが画面に見えている範囲（client px）。map: canvas = (client - left/top) · scale */
export type CalibArea = { left: number; top: number; width: number; height: number };
export type CalibMap = { left: number; top: number; scale: number };
type Trial = { kind: PathKind; rawErr: number; shownErr: number };
type Guide = { kind: PathKind; path: Pt[] }; // path はキャンバス座標
/** 表示: 画面座標 = (tx, ty) + z · R(rot) · キャンバス座標 */
type View = { tx: number; ty: number; z: number; rot: number };
type ViewGesture = { mode: 'pan' | 'zoom' | 'rot'; sx: number; sy: number; v0: View; startAngle: number; px: number; py: number };
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const BAR_H = 52; // 上部バーの高さ（目標線をここに重ねない）

const BLOCK = 21; // 1 セットの試行数（3 種類 × 7）
const MARGIN = 40;
const KINDS: PathKind[] = ['line', 'arc', 's'];
const DIR_ARROW = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];

/* ---------------------------------------------------------------- 表示用 */

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
function lateralText(v: number) {
  if (!Number.isFinite(v) || Math.abs(v) < 0.5) return '左右の偏りなし';
  return `進行方向の${v > 0 ? '右' : '左'}へ ${Math.abs(v).toFixed(1)}px`;
}
function outwardText(v: number | null) {
  if (v === null || !Number.isFinite(v)) return '';
  if (Math.abs(v) < 0.5) return '／カーブの深さは合っている';
  return v > 0 ? `／カーブの外側へ ${v.toFixed(1)}px（浅く描く傾向）` : `／カーブの内側へ ${(-v).toFixed(1)}px（きつく描く傾向）`;
}

export function WarpCalibration({
  warp,
  area,
  map,
  docSize,
  method,
  onClose,
}: {
  /** 学習先の場（方式A＝キャンバス座標の場、方式B＝画面座標の場） */
  warp: WarpField;
  method: WarpMethod;
  area: CalibArea;
  map: CalibMap;
  /** キャンバスの大きさ（紙として描く範囲） */
  docSize: { width: number; height: number };
  onClose: (trials: number) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  // 視点（開始時はエディタと同じ見え方）と視点操作の状態
  const viewRef = useRef<View>({ tx: map.left, ty: map.top, z: 1 / map.scale, rot: 0 });
  const keysRef = useRef({ space: false, zoom: false, rot: false });
  const gestureRef = useRef<ViewGesture | null>(null);
  const strokeDocRef = useRef<Pt[]>([]); // 描いている線（キャンバス座標）。視点を変えたときの描き直し用
  const [, rerender] = useState(0);
  const guideRef = useRef<Guide | null>(null);
  const strokeRef = useRef<{ rx: number; ry: number; sx: number; sy: number } | null>(null);
  const busyRef = useRef(false);
  const doneRef = useRef(0);
  const dirtyRef = useRef(false); // 最適化していない試行があるか
  const kindQueueRef = useRef<PathKind[]>([]);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [blockStart, setBlockStart] = useState(0);
  const [msg, setMsg] = useState('緑の点（始点）から赤い丸（終点）まで、青い経路に沿ってなぞってください');
  const [analysis, setAnalysis] = useState<{ opt: OptResult; tend: Tendency } | null>(null);

  const block = trials.slice(blockStart);
  const finished = block.length >= BLOCK;
  // setTimeout 内からも最新値を見られるように ref にも写す
  const finishedRef = useRef(finished);
  finishedRef.current = finished;

  const ctx = () => cvRef.current?.getContext('2d') ?? null;

  /** 直線・円弧・S字が同じ数ずつ、ランダムな順で出るようにする。 */
  const nextKind = (): PathKind => {
    if (kindQueueRef.current.length === 0) {
      const q: PathKind[] = [];
      for (let i = 0; i < BLOCK / KINDS.length; i++) q.push(...KINDS);
      kindQueueRef.current = q.sort(() => Math.random() - 0.5);
    }
    return kindQueueRef.current.pop()!;
  };

  /* ------------------------------------------------------------ 座標（視点） */

  const toClient = (p: Pt): Pt => {
    const v = viewRef.current;
    const th = (v.rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    return { x: v.tx + v.z * (p.x * c - p.y * s), y: v.ty + v.z * (p.x * s + p.y * c) };
  };
  const toDoc = (p: Pt): Pt => {
    const v = viewRef.current;
    const th = (-v.rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const dx = p.x - v.tx;
    const dy = p.y - v.ty;
    return { x: (dx * c - dy * s) / v.z, y: (dx * s + dy * c) / v.z };
  };

  const newGuide = () => {
    // いま画面に見えているキャンバスの範囲に経路を置く。
    // 最初の 1 本はエディタで見えていた範囲（area）、以降は画面内でキャンバスの上に収まる範囲。
    const first = !guideRef.current;
    const L = (first ? Math.max(area.left, 0) : 0) + MARGIN;
    const T = (first ? Math.max(area.top, 0) : BAR_H) + MARGIN;
    const R = (first ? Math.min(area.left + area.width, window.innerWidth) : window.innerWidth) - MARGIN;
    const B = (first ? Math.min(area.top + area.height, window.innerHeight) : window.innerHeight) - MARGIN;
    const w = Math.max(R - L, 60);
    const h = Math.max(B - T, 60);
    const onScreen = (p: Pt) => p.x >= L && p.x <= L + w && p.y >= T && p.y <= T + h;
    const onPaper = (q: Pt) => q.x >= 0 && q.x <= docSize.width && q.y >= 0 && q.y <= docSize.height;
    const kind = nextKind();
    for (let k = 0; k < 300; k++) {
      const path = genPath(kind, L, T, w, h);
      if (!path.every(onScreen)) continue;
      const doc = path.map(toDoc);
      if (doc.every(onPaper)) {
        guideRef.current = { kind, path: doc };
        return;
      }
    }
    // 収まる経路が作れない（キャンバスがほとんど見えていない等）ときは、キャンバス中央の横線
    const cy = docSize.height / 2;
    guideRef.current = {
      kind: 'line',
      path: resample([
        { x: docSize.width * 0.2, y: cy },
        { x: docSize.width * 0.8, y: cy },
      ]),
    };
  };

  const drawScene = () => {
    const c = ctx();
    if (!c) return;
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // 紙（キャンバス全体。回転・ズームに合わせて写す）
    const corners = [
      { x: 0, y: 0 },
      { x: docSize.width, y: 0 },
      { x: docSize.width, y: docSize.height },
      { x: 0, y: docSize.height },
    ].map(toClient);
    c.fillStyle = '#fff';
    c.beginPath();
    corners.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.closePath();
    c.fill();
    const g = guideRef.current;
    if (!g || finishedRef.current) return;
    const p = g.path.map(toClient);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,150,255,.3)';
    c.lineWidth = 10;
    c.beginPath();
    c.moveTo(p[0].x, p[0].y);
    for (const q of p) c.lineTo(q.x, q.y);
    c.stroke();
    // 進む向きの矢印（経路の 25% 地点）
    const i = Math.floor(p.length * 0.25);
    const a = p[Math.max(0, i - 3)];
    const b = p[Math.min(p.length - 1, i + 3)];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    c.strokeStyle = 'rgba(0,110,220,.8)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(p[i].x - 9 * Math.cos(ang - 0.5), p[i].y - 9 * Math.sin(ang - 0.5));
    c.lineTo(p[i].x, p[i].y);
    c.lineTo(p[i].x - 9 * Math.cos(ang + 0.5), p[i].y - 9 * Math.sin(ang + 0.5));
    c.stroke();
    // 始点（緑）・終点（赤）
    const s = p[0];
    const e = p[p.length - 1];
    c.fillStyle = '#2a2';
    c.beginPath();
    c.arc(s.x, s.y, 7, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#c33';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(e.x, e.y, 7, 0, Math.PI * 2);
    c.stroke();
    // 描いている途中・描き終えた直後の線（補正なし）
    const sd = strokeDocRef.current;
    if (sd.length > 1) {
      const q = sd.map(toClient);
      c.strokeStyle = '#111';
      c.lineWidth = 2.5;
      c.beginPath();
      q.forEach((r, j) => (j ? c.lineTo(r.x, r.y) : c.moveTo(r.x, r.y)));
      c.stroke();
    }
  };

  // キャンバスの初期化（画面サイズ × DPR）
  useEffect(() => {
    const cv = cvRef.current!;
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(window.innerWidth * dpr);
      cv.height = Math.round(window.innerHeight * dpr);
      cv.style.width = `${window.innerWidth}px`;
      cv.style.height = `${window.innerHeight}px`;
      cv.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!guideRef.current) newGuide();
      drawScene();
    };
    setup();
    window.addEventListener('resize', setup);
    return () => window.removeEventListener('resize', setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    drawScene();
    // 1 セット終わったら、傾向の集計と最適化（重いので描画を挟んでから）
    if (finished && dirtyRef.current) {
      const t = window.setTimeout(() => {
        const opt = warp.optimize();
        dirtyRef.current = false;
        setAnalysis({ opt, tend: warp.tendency() });
      }, 30);
      return () => window.clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  const close = () => {
    if (dirtyRef.current) warp.optimize(); // 途中終了でも、そこまでの試行で最適化してから戻る
    onClose(doneRef.current);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  // オーバーレイ表示中はエディタのショートカットを止める。Esc で閉じる。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (setViewKeyRef.current(e, true)) return;
      if (e.key === 'Escape') closeRef.current();
    };
    const up = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      setViewKeyRef.current(e, false);
    };
    const blur = () => {
      keysRef.current = { space: false, zoom: false, rot: false };
      updateCursorStyle();
    };
    window.addEventListener('keydown', h, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', h, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ 視点操作（エディタと同じキー） */

  /** Space / Z / D の押下状態を更新。視点操作のキーなら true。 */
  const viewLocked = method === 'A'; // 方式A では視点操作を使わない
  const setViewKey = (e: KeyboardEvent, down: boolean): boolean => {
    if (viewLocked) return false;
    if (down && (e.ctrlKey || e.metaKey)) return false;
    const k = keysRef.current;
    let hit = true;
    if (e.key === ' ') {
      k.space = down;
      e.preventDefault();
    } else if (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') k.zoom = down;
    else if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') k.rot = down;
    else hit = false;
    if (hit) updateCursorStyle();
    return hit;
  };
  const setViewKeyRef = useRef(setViewKey);
  setViewKeyRef.current = setViewKey;
  const updateCursorStyle = () => {
    const cv = cvRef.current;
    if (!cv) return;
    const k = keysRef.current;
    cv.style.cursor = k.space ? 'grab' : k.zoom ? 'ns-resize' : k.rot ? 'alias' : 'crosshair';
  };
  const redraw = () => {
    drawScene();
    rerender((x) => x + 1);
  };
  const startGesture = (mode: ViewGesture['mode'], e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても続行 */
    }
    const px = window.innerWidth / 2; // 回転の軸＝画面中央（エディタと同じ）
    const py = window.innerHeight / 2;
    gestureRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      v0: { ...viewRef.current },
      startAngle: Math.atan2(e.clientY - py, e.clientX - px),
      px,
      py,
    };
  };
  /** 画面上の点 (ax, ay) を動かさずにズーム。 */
  const zoomAround = (v0: View, z1: number, ax: number, ay: number): View => {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z1));
    const k = z / v0.z;
    return { ...v0, z, tx: ax - (ax - v0.tx) * k, ty: ay - (ay - v0.ty) * k };
  };
  /** 画面上の点 (px, py) を動かさずに回転を deg に。 */
  const rotateAround = (v0: View, deg: number, px: number, py: number): View => {
    const d = ((deg - v0.rot) * Math.PI) / 180;
    const rx = v0.tx - px;
    const ry = v0.ty - py;
    return { ...v0, rot: deg, tx: px + rx * Math.cos(d) - ry * Math.sin(d), ty: py + rx * Math.sin(d) + ry * Math.cos(d) };
  };
  const moveGesture = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gestureRef.current!;
    if (g.mode === 'pan') {
      viewRef.current = { ...g.v0, tx: g.v0.tx + (e.clientX - g.sx), ty: g.v0.ty + (e.clientY - g.sy) };
    } else if (g.mode === 'zoom') {
      viewRef.current = zoomAround(g.v0, g.v0.z * Math.pow(1.01, g.sy - e.clientY), g.sx, g.sy);
    } else {
      let deg = g.v0.rot + ((Math.atan2(e.clientY - g.py, e.clientX - g.px) - g.startAngle) * 180) / Math.PI;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else if (Math.abs(deg) < 1.5) deg = 0;
      viewRef.current = rotateAround(g.v0, deg, g.px, g.py);
    }
    redraw();
  };
  const resetRotation = () => {
    if (strokeRef.current) return;
    viewRef.current = rotateAround(viewRef.current, 0, window.innerWidth / 2, window.innerHeight / 2);
    redraw();
  };

  // ホイール: Ctrl/⌘ ＋ ホイール＝ズーム、ホイールのみ＝移動
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewLocked || strokeRef.current) return; // 方式A・描いている最中は動かさない
      const v = viewRef.current;
      viewRef.current = e.ctrlKey || e.metaKey
        ? zoomAround(v, v.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY)
        : { ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY };
      redraw();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ ペン入力 */

  const addPoint = (x: number, y: number, pressure: number) => {
    const q = toDoc({ x, y });
    // 補正前の軌跡を学習用に記録する（戻り値の変位は使わない＝学習中は補正なしで表示する）。
    // 方式A はキャンバス座標、方式B は画面の入力座標で記録する。
    if (method === 'A') warp.feed(q.x, q.y);
    else warp.feed(x, y);
    const sx = x;
    const sy = y;
    const s = strokeRef.current;
    const c = ctx();
    if (s && c) {
      c.lineCap = 'round';
      c.strokeStyle = '#111'; // 手の動きそのままの線（補正なし）
      c.lineWidth = 1 + 4 * pressure;
      c.beginPath();
      c.moveTo(s.sx, s.sy);
      c.lineTo(sx, sy);
      c.stroke();
    }
    strokeRef.current = { rx: x, ry: y, sx, sy };
    strokeDocRef.current.push(q);
  };
  const pressureOf = (e: PointerEvent | ReactPointerEvent) =>
    e.pointerType === 'mouse' ? 0.5 : e.pressure > 0 ? e.pressure : 0.5;

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (strokeRef.current || gestureRef.current) return;
    // 視点操作は描画より優先（いつでも使える）
    const k = keysRef.current;
    if (viewLocked && e.button === 1) return; // 方式A: 中ボタンのパンは無効
    if (e.button === 1 || k.space) return startGesture('pan', e);
    if (k.zoom) return startGesture('zoom', e);
    if (k.rot) return startGesture('rot', e);
    if (busyRef.current || finishedRef.current || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても続行 */
    }
    warp.begin();
    strokeRef.current = null;
    strokeDocRef.current = [];
    addPoint(e.clientX, e.clientY, pressureOf(e));
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (gestureRef.current) {
      moveGesture(e);
      return;
    }
    if (!strokeRef.current) return;
    const n = e.nativeEvent;
    const evs = typeof n.getCoalescedEvents === 'function' ? n.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [n]) addPoint(ev.clientX, ev.clientY, pressureOf(ev));
  };
  const onUp = () => {
    if (gestureRef.current) {
      gestureRef.current = null;
      return;
    }
    if (!strokeRef.current) return;
    strokeRef.current = null;
    const g = guideRef.current!;
    // 方式A: 目標線も軌跡もキャンバス座標。
    // 方式B: 目標線をいまの視点で画面座標に写す（描いている間は視点が変わらないので、軌跡と同じ座標系になる）。
    const r = warp.endTrace(method === 'A' ? g.path : g.path.map(toClient), g.kind);
    busyRef.current = true;
    if (!r.ok) {
      setMsg('短すぎるため学習しませんでした（始点から終点までなぞってください）');
      setTimeout(() => {
        strokeDocRef.current = [];
        drawScene();
        busyRef.current = false;
      }, 500);
      return;
    }
    doneRef.current += 1;
    dirtyRef.current = true;
    setTrials((t) => [...t, { kind: g.kind, rawErr: r.rawErr, shownErr: r.shownErr }]);
    setMsg(`${KIND_LABEL[g.kind]}: 目標線からのズレ ${f1(r.rawErr)}px（補正なし）`);
    setTimeout(() => {
      strokeDocRef.current = [];
      if (!finishedRef.current) newGuide();
      drawScene();
      busyRef.current = false;
    }, 600);
  };

  const avg = (a: Trial[], k: 'rawErr' | 'shownErr') =>
    a.length ? a.reduce((s, t) => s + t[k], 0) / a.length : NaN;
  const half = Math.floor(block.length / 2);

  const renderAnalysis = () => {
    if (!analysis) return <div className="muted">ズレ方の傾向を集計し、補正のかけ方を最適化しています…</div>;
    const { opt, tend } = analysis;
    const p = opt.params;
    const dirs = [...tend.byDir].sort((a, b) => b.err - a.err);
    return (
      <>
        <div className="warp-calib-h">ズレ方の傾向（これまでの全 {opt.trials} 試行）</div>
        {tend.byKind.map((k) => (
          <div key={k.kind}>
            {KIND_LABEL[k.kind]}（{k.n}本）: 平均 {f1(k.err)}px ／ {lateralText(k.lateral)}
            {k.kind !== 'line' && outwardText(k.outward)}
          </div>
        ))}
        <div>
          {tend.byPhase.map((ph) => `${ph.label} ${f1(ph.err)}px`).join(' ／ ')}
        </div>
        {dirs.length >= 2 && (
          <div>
            ズレやすい向き {DIR_ARROW[dirs[0].deg / 45]} {f1(dirs[0].err)}px ／ 得意な向き{' '}
            {DIR_ARROW[dirs[dirs.length - 1].deg / 45]} {f1(dirs[dirs.length - 1].err)}px
          </div>
        )}
        <div className="warp-calib-h">補正のかけ方の最適化（交差検証）</div>
        <div>
          補正なし {f1(opt.before)}px → 既定の補正 {f1(opt.defaultErr)}px → 最適化後 <b>{f1(opt.after)}px</b>
        </div>
        <div className="muted">
          なめらかさ λ={p.smooth}（大きいほどキャンバス全体がゆるやかに歪む）／ 強さ {p.strength}
        </div>
      </>
    );
  };

  return (
    <div className="warp-calib" ref={rootRef}>
      <canvas
        ref={cvRef}
        style={{ position: 'absolute', left: 0, top: 0, touchAction: 'none', cursor: 'crosshair' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="warp-calib-bar">
        <b>場のゆがみキャリブレーション</b>
        <span>
          {Math.min(block.length, BLOCK)} / {BLOCK} 本
        </span>
        <span className="warp-calib-msg">{msg}</span>
        <span className="muted">{WARP_METHOD_LABEL[method]}</span>
        {viewLocked ? (
          <span className="muted">視点操作なし</span>
        ) : (
          <span
            className="muted"
            title="Space / 中ボタン＝移動、Z＋上下ドラッグ・Ctrl＋ホイール＝ズーム、D＋ドラッグ＝回転（Shift で 15° 刻み）"
          >
            {Math.round(viewRef.current.z * 100)}% ／{' '}
            <span className="warp-test-rot" onClick={resetRotation} title="クリックで回転を 0° に戻す">
              {Math.round(viewRef.current.rot)}°
            </span>
          </span>
        )}
        <span className="muted">試行 {warp.trialCount}</span>
        <button onClick={close}>終了して描画に戻る (Esc)</button>
      </div>
      {finished && (
        <div className="warp-calib-summary">
          <div>
            <b>{BLOCK} 本 完了</b>　目標線からのズレ（補正なし）平均 {f1(avg(block, 'rawErr'))}px（前半{' '}
            {f1(avg(block.slice(0, half), 'rawErr'))} → 後半 {f1(avg(block.slice(half), 'rawErr'))}）
          </div>
          {renderAnalysis()}
          <div className="warp-calib-actions">
            <button
              disabled={!analysis}
              onClick={() => {
                setAnalysis(null);
                setBlockStart(trials.length);
                newGuide();
                setMsg('続けてなぞってください（学習中は補正なしで表示します）');
              }}
            >
              さらに {BLOCK} 本
            </button>
            <button className="primary" disabled={!analysis} onClick={close}>
              完了して描画に戻る
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
