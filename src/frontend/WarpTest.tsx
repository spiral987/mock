import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PathKind, Pt, WarpField } from './warpField';
import type { CalibArea, CalibMap } from './WarpCalibration';
import { genPath, polyLength, resample, seededRng, shuffle, type Rng } from './warpPaths';
import {
  COND_LABEL,
  KIND_JA,
  byLine,
  endError,
  meanDeviation,
  summarize,
  toCsv,
  type Cond,
  type TrialRecord,
} from './warpTestStats';
import { WARP_METHOD_LABEL, type WarpMethod } from './warpMethod';

/**
 * ③ 補正の効果測定（学習は一切しない）。
 *
 * 流れ
 *   1. 練習 2 本（記録しない）
 *   2. 本番 24 本 = 目標線 12 本（直線・円弧・S字 各 4）× 補正なし・あり 各 1 回
 *        前半 12 本: 12 本の目標線を 1 回ずつ。種類ごとに 2 本は補正なし、2 本は補正あり。
 *        後半 12 本: 同じ 12 本をもう 1 回ずつ。前半と逆の条件で。
 *        前半・後半それぞれの中の順番はランダム。
 *      → どちらの条件も前半と後半に 6 本ずつ入るので、慣れの影響が両条件に同じだけ入る。
 *   3. 結果（1 本ごとの結果、条件ごとの平均、目標線ごとの比較、CSV）
 *
 * 目標線は ① の学習（キャリブレーション）とは別に、種を固定した乱数で作る（学習データは使わない）。
 * 描いている最中は補正なし・ありを表示しない。補正の強さはテスト開始時の値で固定し、記録に残す。
 * 目標線・描いた線はキャンバス座標で持ち、「画面 = T + z·R(θ)·キャンバス」で写して表示する。
 * 実験方式ごとの視点操作と補正のかけ方はエディタと同じ（warpMethod.ts）:
 *   方式A: 視点操作なし。キャンバス座標の点に、キャンバス座標の場の変位を足す。
 *   方式B: 視点操作あり（Space / 中ボタン＝移動、Z＋上下ドラッグ・Ctrl＋ホイール＝ズーム、D＋ドラッグ＝回転、
 *          ホイール＝移動）。画面の入力位置に画面座標の場の変位を足してから、キャンバス座標に戻す。
 */

const SEED = 20261019; // 本番の目標線（同じ表示範囲なら毎回同じ 12 本）
const PRACTICE_SEED = SEED + 1; // 練習の目標線（本番とは別の線）
const KINDS: PathKind[] = ['line', 'arc', 's'];
const PER_KIND = 4;
const PRACTICE = 2;
const HOLD_MS = 500; // 描き終えた線を残しておく時間
const MARGIN = 40;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;

type Spec = {
  phase: 'practice' | 'main';
  lineId: string;
  kind: PathKind;
  cond: Cond;
  half: 1 | 2;
  doc: Pt[]; // 目標線（キャンバス座標）
};
type Stage = 'intro' | 'ready' | 'drawing' | 'hold' | 'result';
/** 表示: 画面座標 = (tx, ty) + z · R(rot) · キャンバス座標 */
type View = { tx: number; ty: number; z: number; rot: number };
type ViewGesture = {
  mode: 'pan' | 'zoom' | 'rot';
  sx: number;
  sy: number;
  v0: View;
  startAngle: number;
  px: number;
  py: number;
};

/* ---------------------------------------------------------------- 試行の組み立て */

function makeTrials(area: CalibArea, map: CalibMap): { practice: Spec[]; main: Spec[] } {
  // 目標線は、テスト開始時にキャンバスが見えている範囲の中に作る
  const L = Math.max(area.left, 0) + MARGIN;
  const T = Math.max(area.top, 0) + MARGIN;
  const R = Math.min(area.left + area.width, window.innerWidth) - MARGIN;
  const B = Math.min(area.top + area.height, window.innerHeight) - MARGIN;
  const w = Math.max(R - L, 60);
  const h = Math.max(B - T, 60);
  const inside = (p: Pt) => p.x >= L && p.x <= L + w && p.y >= T && p.y <= T + h;
  const toDoc = (p: Pt): Pt => ({ x: (p.x - map.left) * map.scale, y: (p.y - map.top) * map.scale });
  const gen = (kind: PathKind, rng: Rng): Pt[] => {
    for (let k = 0; k < 400; k++) {
      const path = genPath(kind, L, T, w, h, rng);
      if (path.every(inside)) return path.map(toDoc);
    }
    const cy = T + h / 2;
    return resample([{ x: L, y: cy }, { x: L + w, y: cy }]).map(toDoc);
  };

  // 本番の目標線 12 本
  const rng = seededRng(SEED);
  const lines = KINDS.flatMap((kind) => Array.from({ length: PER_KIND }, () => ({ kind, doc: gen(kind, rng) }))).map(
    (l, i) => ({ ...l, lineId: `L${String(i + 1).padStart(2, '0')}` }),
  );
  // 前半の条件：種類ごとに 2 本を補正なし、2 本を補正あり（どの線にするかはランダム）
  const firstCond = new Map<string, Cond>();
  for (const kind of KINDS) {
    const ids = shuffle(lines.filter((l) => l.kind === kind).map((l) => l.lineId), rng);
    ids.forEach((id, i) => firstCond.set(id, i < PER_KIND / 2 ? 'off' : 'on'));
  }
  const first: Spec[] = shuffle(
    lines.map((l) => ({ ...l, phase: 'main' as const, cond: firstCond.get(l.lineId)!, half: 1 as const })),
    rng,
  );
  // 後半：同じ線を逆の条件で。前半の最後と後半の最初が同じ線にならないようにする
  let second: Spec[] = [];
  for (let k = 0; k < 100; k++) {
    second = shuffle(
      lines.map((l) => ({
        ...l,
        phase: 'main' as const,
        cond: (firstCond.get(l.lineId) === 'off' ? 'on' : 'off') as Cond,
        half: 2 as const,
      })),
      rng,
    );
    if (second[0].lineId !== first[first.length - 1].lineId) break;
  }

  // 練習 2 本（本番とは別の線。補正なし・ありを 1 本ずつ）
  const prng = seededRng(PRACTICE_SEED);
  const pk = shuffle([...KINDS], prng).slice(0, PRACTICE);
  const pc = shuffle(['off', 'on'] as Cond[], prng);
  const practice: Spec[] = pk.map((kind, i) => ({
    phase: 'practice',
    lineId: `P${i + 1}`,
    kind,
    cond: pc[i % 2],
    half: 1,
    doc: gen(kind, prng),
  }));
  return { practice, main: [...first, ...second] };
}

/* ---------------------------------------------------------------- 表示用 */

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-');
const sgn = (v: number, d = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}` : '-');

export function WarpTest({
  warp,
  area,
  map,
  docSize,
  method,
  onClose,
}: {
  warp: WarpField;
  area: CalibArea;
  map: CalibMap;
  /** キャンバスの大きさ（紙として描く範囲） */
  docSize: { width: number; height: number };
  /** 実験方式（方式A＝キャンバス座標の場、方式B＝画面座標の場。warp はその方式の場） */
  method: WarpMethod;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLCanvasElement>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const trials = useMemo(() => makeTrials(area, map), [area, map]);
  const S = useRef({
    phase: 'practice' as 'practice' | 'main',
    index: 0,
    stage: 'intro' as Stage,
    retries: 0,
    msg: '',
    records: [] as TrialRecord[],
    raw: [] as Pt[], // 描いた点（キャンバス座標・補正前）
    shown: [] as Pt[], // 表示した線（キャンバス座標・条件どおり補正後）
    t0: 0,
    t1: 0,
    pointerType: '',
    last: null as Pt | null,
    timer: 0,
    // 補正の強さ・なめらかさはテスト開始時の値で固定して記録する
    strength: warp.params.strength,
    smooth: warp.params.smooth,
    // 視点（開始時はエディタと同じ見え方）
    view: { tx: map.left, ty: map.top, z: 1 / map.scale, rot: 0 } as View,
    keys: { space: false, zoom: false, rot: false },
    gesture: null as ViewGesture | null,
  });
  const st = S.current;
  const list = () => (st.phase === 'practice' ? trials.practice : trials.main);
  const spec = (): Spec | null => list()[st.index] ?? null;
  const setStage = (s: Stage) => {
    st.stage = s;
    rerender();
  };

  /* ------------------------------------------------------------ 座標（視点） */

  const toClient = (p: Pt): Pt => {
    const v = st.view;
    const th = (v.rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    return { x: v.tx + v.z * (p.x * c - p.y * s), y: v.ty + v.z * (p.x * s + p.y * c) };
  };
  const toDoc = (p: Pt): Pt => {
    const v = st.view;
    const th = (-v.rot * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const dx = p.x - v.tx;
    const dy = p.y - v.ty;
    return { x: (dx * c - dy * s) / v.z, y: (dx * s + dy * c) / v.z };
  };
  /**
   * その試行の条件で表示する位置（キャンバス座標）。補正なしなら入力位置そのまま。
   * 補正ありは「学習済みの変位 × テスト開始時の強さ」を足す（回転中は変位を −θ 回す。エディタと同じ）。
   */
  const shownDocOf = (q: Pt, cond: Cond): Pt => {
    if (cond === 'off' || st.strength === 0 || warp.params.strength === 0) return q;
    const k = st.strength / warp.params.strength; // テスト中に強さが変わっても開始時の値で固定する
    if (method === 'A') {
      // 方式A: キャンバス座標の点に、キャンバス座標の変位をそのまま足す
      const [dx, dy] = warp.displacementAt(q.x, q.y); // = 現在の強さ × 場
      return { x: q.x + dx * k, y: q.y + dy * k };
    }
    // 方式B: 画面の入力位置に、画面座標の変位を足してからキャンバス座標に戻す
    const c = toClient(q);
    const [dx, dy] = warp.displacementAt(c.x, c.y);
    return toDoc({ x: c.x + dx * k, y: c.y + dy * k });
  };

  /* ------------------------------------------------------------ 描画 */

  const drawScene = () => {
    const c = sceneRef.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // 紙（キャンバス全体）
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
    const sp = spec();
    if (!sp || st.stage === 'intro' || st.stage === 'result') return;
    // 目標線（青い帯）と進む向きの矢印、始点（緑）・終点（赤）
    const p = sp.doc.map(toClient);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(0,150,255,.3)';
    c.lineWidth = 10;
    c.beginPath();
    p.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
    c.stroke();
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
    const s0 = p[0];
    const e0 = p[p.length - 1];
    c.fillStyle = '#2a2';
    c.beginPath();
    c.arc(s0.x, s0.y, 7, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#c33';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(e0.x, e0.y, 7, 0, Math.PI * 2);
    c.stroke();
    // 描いている途中・描き終えた直後の線
    if ((st.stage === 'drawing' || st.stage === 'hold') && st.shown.length > 1) {
      const q = st.shown.map(toClient);
      c.strokeStyle = '#111';
      c.lineWidth = 2.5;
      c.beginPath();
      q.forEach((r, j) => (j ? c.lineTo(r.x, r.y) : c.moveTo(r.x, r.y)));
      c.stroke();
    }
  };

  /** ペンを浮かせているときのカーソルも、その試行の条件どおりの位置に出す。 */
  const drawCursor = (p: Pt | null) => {
    const c = cursorRef.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const sp = spec();
    if (!p || !sp || st.gesture || !['ready', 'drawing'].includes(st.stage)) return;
    const q = toClient(shownDocOf(toDoc(p), sp.cond));
    c.strokeStyle = 'rgba(0,0,0,.75)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(q.x - 6, q.y);
    c.lineTo(q.x + 6, q.y);
    c.moveTo(q.x, q.y - 6);
    c.lineTo(q.x, q.y + 6);
    c.stroke();
  };

  useEffect(() => {
    const setup = () => {
      const dpr = window.devicePixelRatio || 1;
      for (const cv of [sceneRef.current, cursorRef.current]) {
        if (!cv) continue;
        cv.width = Math.round(window.innerWidth * dpr);
        cv.height = Math.round(window.innerHeight * dpr);
        cv.style.width = `${window.innerWidth}px`;
        cv.style.height = `${window.innerHeight}px`;
        cv.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      drawScene();
    };
    setup();
    window.addEventListener('resize', setup);
    return () => {
      window.removeEventListener('resize', setup);
      window.clearTimeout(st.timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ 進行 */

  const beginTrial = () => {
    st.shown = [];
    st.stage = 'ready';
    drawScene();
    rerender();
  };

  const next = () => {
    st.retries = 0;
    st.msg = '';
    st.index++;
    if (st.index < list().length) return beginTrial();
    if (st.phase === 'practice') {
      st.phase = 'main';
      st.index = 0;
      setStage('intro');
    } else {
      setStage('result');
    }
    drawScene();
  };

  const finishStroke = () => {
    const sp = spec()!;
    // 短すぎる線（目標線の半分未満）はやり直し
    if (st.raw.length < 3 || polyLength(st.raw) < polyLength(sp.doc) * 0.5) {
      st.retries++;
      st.msg = '短すぎました。始点から終点まで描いてください（同じ目標線でやり直します）';
      setStage('hold');
      st.timer = window.setTimeout(beginTrial, 700);
      return;
    }
    if (sp.phase === 'main') {
      st.records.push({
        no: st.records.length + 1,
        half: sp.half,
        lineId: sp.lineId,
        kind: sp.kind,
        cond: sp.cond,
        meanDev: meanDeviation(st.shown, sp.doc),
        endErr: endError(st.shown, sp.doc),
        durationSec: Math.max(0, st.t1 - st.t0) / 1000,
        retries: st.retries,
        method,
        strength: st.strength,
        smooth: st.smooth,
        viewScale: 1 / st.view.z,
        viewRotation: st.view.rot,
        pointerType: st.pointerType,
        time: new Date().toISOString(),
      });
    }
    st.msg = '';
    setStage('hold');
    st.timer = window.setTimeout(next, HOLD_MS);
  };

  const toResult = () => {
    window.clearTimeout(st.timer);
    setStage('result');
    drawScene();
    drawCursor(null);
  };
  const confirmAbort = () => {
    if (window.confirm('テストを中断して、ここまでの結果を表示しますか？')) toResult();
  };

  /* ------------------------------------------------------------ キー（視点操作・中断） */

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    e.stopImmediatePropagation(); // テスト中はエディタのショートカットを止める
    if (setViewKey(e, true)) return;
    if (e.key === 'Escape') {
      if (st.stage === 'result') onClose();
      else confirmAbort();
    }
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      setViewKey(e, false);
    };
    const blur = () => {
      st.keys = { space: false, zoom: false, rot: false };
      updateCursorStyle();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', blur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Space / Z / D の押下状態を更新。視点操作のキーなら true。 */
  const viewLocked = method === 'A'; // 方式A では視点操作を使わない
  const setViewKey = (e: KeyboardEvent, down: boolean): boolean => {
    if (viewLocked) return false;
    if (down && (e.ctrlKey || e.metaKey)) return false;
    let hit = true;
    if (e.key === ' ') {
      st.keys.space = down;
      e.preventDefault();
    } else if (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ') st.keys.zoom = down;
    else if (e.key === 'd' || e.key === 'D' || e.code === 'KeyD') st.keys.rot = down;
    else hit = false;
    if (hit) updateCursorStyle();
    return hit;
  };
  const updateCursorStyle = () => {
    const cv = cursorRef.current;
    if (!cv) return;
    const k = st.keys;
    cv.style.cursor = k.space ? 'grab' : k.zoom ? 'ns-resize' : k.rot ? 'alias' : 'none';
    if (k.space || k.zoom || k.rot) drawCursor(null);
  };

  /* ------------------------------------------------------------ 視点操作（エディタと同じ） */

  const redraw = () => {
    drawScene();
    rerender();
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
    st.gesture = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      v0: { ...st.view },
      startAngle: Math.atan2(e.clientY - py, e.clientX - px),
      px,
      py,
    };
    drawCursor(null);
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
    return {
      ...v0,
      rot: deg,
      tx: px + rx * Math.cos(d) - ry * Math.sin(d),
      ty: py + rx * Math.sin(d) + ry * Math.cos(d),
    };
  };
  const moveGesture = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = st.gesture!;
    if (g.mode === 'pan') {
      st.view = { ...g.v0, tx: g.v0.tx + (e.clientX - g.sx), ty: g.v0.ty + (e.clientY - g.sy) };
    } else if (g.mode === 'zoom') {
      st.view = zoomAround(g.v0, g.v0.z * Math.pow(1.01, g.sy - e.clientY), g.sx, g.sy);
    } else {
      let deg = g.v0.rot + ((Math.atan2(e.clientY - g.py, e.clientX - g.px) - g.startAngle) * 180) / Math.PI;
      deg = ((((deg + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else if (Math.abs(deg) < 1.5) deg = 0;
      st.view = rotateAround(g.v0, deg, g.px, g.py);
    }
    redraw();
  };
  const resetRotation = () => {
    if (st.stage === 'drawing') return;
    st.view = rotateAround(st.view, 0, window.innerWidth / 2, window.innerHeight / 2);
    redraw();
  };

  // ホイール: Ctrl/⌘ ＋ ホイール＝ズーム、ホイールのみ＝移動
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (viewLocked || st.stage === 'drawing') return;
      if (e.ctrlKey || e.metaKey) {
        st.view = zoomAround(st.view, st.view.z * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
      } else {
        st.view = { ...st.view, tx: st.view.tx - e.deltaX, ty: st.view.ty - e.deltaY };
      }
      redraw();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ ペン入力 */

  const strokePt = (x: number, y: number, pressure: number) => {
    const sp = spec()!;
    const d = toDoc({ x, y });
    const sd = shownDocOf(d, sp.cond);
    const q = toClient(sd);
    const c = sceneRef.current?.getContext('2d');
    if (st.last && c) {
      c.lineCap = 'round';
      c.strokeStyle = '#111';
      c.lineWidth = 1 + 4 * pressure;
      c.beginPath();
      c.moveTo(st.last.x, st.last.y);
      c.lineTo(q.x, q.y);
      c.stroke();
    }
    st.last = q;
    st.raw.push(d);
    st.shown.push(sd);
  };
  const pressureOf = (e: PointerEvent | ReactPointerEvent) =>
    e.pointerType === 'mouse' ? 0.5 : e.pressure > 0 ? e.pressure : 0.5;

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (st.stage === 'drawing' || st.gesture) return;
    // 視点操作は描画より優先（どの場面でも使える）
    if (viewLocked && e.button === 1) return; // 方式A: 中ボタンのパンは無効
    if (e.button === 1 || st.keys.space) return startGesture('pan', e);
    if (st.keys.zoom) return startGesture('zoom', e);
    if (st.keys.rot) return startGesture('rot', e);
    if (st.stage !== 'ready' || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても続行 */
    }
    st.stage = 'drawing';
    st.raw = [];
    st.shown = [];
    st.last = null;
    st.t0 = e.timeStamp; // 描画時間 = ペンを下ろしてから離すまで
    st.t1 = e.timeStamp;
    st.pointerType = e.pointerType;
    strokePt(e.clientX, e.clientY, pressureOf(e));
    drawCursor(null);
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (st.gesture) {
      moveGesture(e);
      return;
    }
    if (st.stage !== 'drawing') {
      drawCursor({ x: e.clientX, y: e.clientY });
      return;
    }
    const n = e.nativeEvent;
    const evs = typeof n.getCoalescedEvents === 'function' ? n.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [n]) strokePt(ev.clientX, ev.clientY, pressureOf(ev));
    st.t1 = e.timeStamp;
  };
  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (st.gesture) {
      st.gesture = null;
      updateCursorStyle();
      return;
    }
    if (st.stage !== 'drawing') return;
    st.t1 = e.timeStamp;
    finishStroke();
  };

  /* ------------------------------------------------------------ 画面 */

  const saveCsv = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(st.records)], { type: 'text/csv' }));
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    a.download = `warp-test-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.csv`;
    a.click();
  };

  const renderResult = () => {
    const recs = st.records;
    const sum = summarize(recs);
    const lines = byLine(recs);
    return (
      <div className="warp-calib-summary warp-test-result">
        <b>③ 効果測定の結果</b>
        <div className="muted">
          方式 {WARP_METHOD_LABEL[method]} ／ 補正の強さ {st.strength} 倍（テスト開始時の値で固定）／ なめらかさ λ={st.smooth} ／ 学習に使った試行{' '}
          {warp.trialCount} 本 ／ 記録 {recs.length} / {trials.main.length} 本。ズレはキャンバス px。
        </div>

        <div className="warp-calib-h">条件ごとの平均</div>
        <table className="warp-test-table">
          <thead>
            <tr>
              <th>条件</th>
              <th>本数</th>
              <th>平均偏差（px）</th>
              <th>終点のずれ（px）</th>
              <th>描画時間（秒）</th>
            </tr>
          </thead>
          <tbody>
            <tr className="warp-cond-off">
              <td>補正なし</td>
              <td>{sum.off.n}</td>
              <td>{f2(sum.off.meanDev)}</td>
              <td>{f2(sum.off.endErr)}</td>
              <td>{f2(sum.off.durationSec)}</td>
            </tr>
            <tr className="warp-cond-on">
              <td>補正あり</td>
              <td>{sum.on.n}</td>
              <td>{f2(sum.on.meanDev)}</td>
              <td>{f2(sum.on.endErr)}</td>
              <td>{f2(sum.on.durationSec)}</td>
            </tr>
            <tr>
              <td>差（あり − なし）</td>
              <td />
              <td>{sgn(sum.on.meanDev - sum.off.meanDev, 2)}</td>
              <td>{sgn(sum.on.endErr - sum.off.endErr, 2)}</td>
              <td>{sgn(sum.on.durationSec - sum.off.durationSec, 2)}</td>
            </tr>
          </tbody>
        </table>
        <div className="muted">差がマイナスなら、補正ありのほうがズレが小さい（時間なら短い）ことを表します。</div>

        <div className="warp-calib-h">目標線ごとの比較（同じ目標線の補正なし / あり）</div>
        {lines.length === 0 ? (
          <div className="muted">補正なし・ありの両方を描いた目標線はまだありません。</div>
        ) : (
          <table className="warp-test-table">
            <thead>
              <tr>
                <th>目標線</th>
                <th>種類</th>
                <th>平均偏差 なし → あり</th>
                <th>終点のずれ なし → あり</th>
                <th>描画時間 なし → あり</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId}>
                  <td>{l.lineId}</td>
                  <td>{KIND_JA[l.kind]}</td>
                  <td>
                    {f1(l.off.meanDev)} → {f1(l.on.meanDev)}
                  </td>
                  <td>
                    {f1(l.off.endErr)} → {f1(l.on.endErr)}
                  </td>
                  <td>
                    {f2(l.off.durationSec)} → {f2(l.on.durationSec)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="warp-calib-h">1 本ごとの結果（描いた順）</div>
        <table className="warp-test-table">
          <thead>
            <tr>
              <th>試行</th>
              <th>前半/後半</th>
              <th>目標線</th>
              <th>種類</th>
              <th>条件</th>
              <th>平均偏差（px）</th>
              <th>終点のずれ（px）</th>
              <th>描画時間（秒）</th>
              <th>やり直し</th>
            </tr>
          </thead>
          <tbody>
            {recs.map((r) => (
              <tr key={r.no} className={r.cond === 'on' ? 'warp-cond-on' : 'warp-cond-off'}>
                <td>{r.no}</td>
                <td>{r.half === 1 ? '前半' : '後半'}</td>
                <td>{r.lineId}</td>
                <td>{KIND_JA[r.kind]}</td>
                <td>{COND_LABEL[r.cond]}</td>
                <td>{f2(r.meanDev)}</td>
                <td>{f2(r.endErr)}</td>
                <td>{f2(r.durationSec)}</td>
                <td>{r.retries}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="warp-calib-actions">
          <button onClick={saveCsv} disabled={recs.length === 0}>
            CSV を保存
          </button>
          <button className="primary" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    );
  };

  const sp = spec();
  const total = list().length;
  return (
    <div className="warp-calib" ref={rootRef}>
      <canvas ref={sceneRef} style={{ position: 'absolute', left: 0, top: 0, touchAction: 'none' }} />
      <canvas
        ref={cursorRef}
        style={{ position: 'absolute', left: 0, top: 0, touchAction: 'none', cursor: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => drawCursor(null)}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="warp-calib-bar">
        <b>③ 補正の効果測定</b>
        {st.stage !== 'result' && (
          <span>
            {st.phase === 'practice' ? '練習（記録しない）' : '本番'}　{Math.min(st.index + 1, total)} / {total}
          </span>
        )}
        <span className="warp-calib-msg">
          {st.msg ||
            (st.stage === 'ready' && sp ? '緑の点（始点）から赤い丸（終点）まで、青い目標線に沿ってなぞってください' : '')}
        </span>
        <span className="muted">{WARP_METHOD_LABEL[method]}</span>
        {st.stage !== 'result' && !viewLocked && (
          <span
            className="muted"
            title="Space / 中ボタン＝移動、Z＋上下ドラッグ・Ctrl＋ホイール＝ズーム、D＋ドラッグ＝回転（Shift で 15° 刻み）"
          >
            {Math.round(st.view.z * 100)}% ／{' '}
            <span className="warp-test-rot" onClick={resetRotation} title="クリックで回転を 0° に戻す">
              {Math.round(st.view.rot)}°
            </span>
          </span>
        )}
        {st.stage === 'result' ? (
          <button onClick={onClose}>閉じる (Esc)</button>
        ) : (
          <button onClick={confirmAbort}>中断して結果へ (Esc)</button>
        )}
      </div>

      {st.stage === 'intro' && (
        <div className="warp-calib-summary">
          {st.phase === 'practice' ? (
            <>
              <b>練習（{trials.practice.length} 本・記録しません）</b>
              <div>緑の点（始点）から赤い丸（終点）まで、青い目標線に沿ってなぞってください。</div>
              <div className="muted">
                このあと本番で {trials.main.length} 本描きます（目標線 {trials.main.length / 2} 本 × 補正なし・あり）。
                補正のあり・なしは描いている間は表示しません。結果画面で確認できます。補正の強さは{' '}
                {st.strength} 倍で固定します。
                {(warp.trialCount === 0 || st.strength === 0) &&
                  ' ※学習データがない、または強さが 0 のため、補正ありとなしは同じになります。'}
              </div>
            </>
          ) : (
            <>
              <b>本番（{trials.main.length} 本）</b>
              <div>ここから記録します。練習と同じように、目標線に沿ってなぞってください。</div>
            </>
          )}
          <div className="warp-calib-actions">
            <button className="primary" onClick={beginTrial}>
              開始
            </button>
          </div>
        </div>
      )}

      {st.stage === 'result' && renderResult()}
    </div>
  );
}
