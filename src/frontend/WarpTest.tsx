import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PathKind, Pt, WarpField } from './warpField';
import type { CalibArea, CalibMap } from './WarpCalibration';
import { genPath, polyLength, seededRng, shuffle, type Rng } from './warpPaths';
import {
  TASK_LABEL,
  analyzeRepeat,
  analyzeTask,
  strokeMetrics,
  toCsv,
  type Cond,
  type Phase,
  type TaskAnalysis,
  type TaskKind,
  type TrialRecord,
} from './warpTestStats';

/**
 * 場のゆがみ補正の効果テスト（学習は一切しない）。
 *
 * 開始時点の補正を固定し、テスト専用のお手本を「補正あり / なし」で 1 回ずつ描いてもらい、
 * お手本ごとに比べる。どちらの条件かは本人に見せない。途中で点数も見せない（その場の上達を防ぐ）。
 *
 *   1. 練習（なぞり）3 本            … 集計しない
 *   2. 本番 A: なぞり               … 3 種類 × 6 本 × 2 条件 = 36 本
 *   3. 練習（記憶描き）3 本
 *   4. 本番 B: 記憶描き             … 経路を 1.5 秒見せて消し、始点と終点だけ残す。36 本
 *   5. 繰り返し（なぞり・補正なし） … 6 本 × 3 回。ズレを「クセ」と「ばらつき」に分ける
 *
 * お手本は種を固定した乱数で作る（同じ表示範囲なら毎回同じ組になる）。
 * 約 8 割は学習データのある範囲、約 2 割は範囲外に置き、どちらかを記録する。
 *
 * テスト中もエディタと同じ操作で視点を変えられる（Space / 中ボタン＝移動、Z＋上下ドラッグ・Ctrl＋ホイール＝
 * ズーム、D＋ドラッグ＝回転、ホイール＝移動）。お手本・線はキャンバス座標で持ち、表示のたびに
 * 「画面 = T + z·R(θ)·キャンバス」で写す。補正のかけ方もエディタと同じ（回転中は変位を −θ 回す）。
 */

const SEED = 20261015;
const KINDS: PathKind[] = ['line', 'arc', 's'];
const PER_KIND = 6; // 1 タスク・1 種類あたりのお手本数（うち OUT_PER_KIND 本は学習範囲外）
const OUT_PER_KIND = 1;
const PRACTICE = 3;
const REPEAT_PER_KIND = 2;
const REPEAT_REPS = 3;
const PREVIEW_MS = 1500; // 記憶描きでお手本を見せる時間
const HOLD_MS = 500; // 描き終えた線を残しておく時間
const MIN_GAP = 6; // 同じお手本の 1 回目と 2 回目の間隔（間に 5 本以上）
const MAX_RUN = 3; // 同じ条件が続いてよい最大本数
const MARGIN = 40;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const RATING_LABELS = ['全くそう思わない', 'あまりそう思わない', 'どちらとも言えない', 'ややそう思う', 'とてもそう思う'];

type Spec = {
  phase: Phase;
  task: TaskKind;
  pathId: string;
  kind: PathKind;
  cond: Cond;
  rep: number;
  path: Pt[]; // 画面座標
  doc: Pt[]; // キャンバス座標
  inArea: boolean;
  coverage: number;
  fieldMag: number;
};
type Block = { title: string; note: string; trials: Spec[] };
type Stage = 'intro' | 'preview' | 'ready' | 'drawing' | 'hold' | 'rating' | 'result';
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

/** お手本の組を、補正あり/なしの順番の制約を満たすように並べる。 */
function orderPairs(ids: string[], rng: Rng): { id: string; cond: Cond }[] {
  for (let attempt = 0; attempt < 3000; attempt++) {
    const first = new Map(ids.map((id) => [id, (rng() < 0.5 ? 'on' : 'off') as Cond]));
    const placedAt = new Map<string, number>();
    const done = new Set<string>();
    const seq: { id: string; cond: Cond }[] = [];
    while (seq.length < ids.length * 2) {
      const last = seq.slice(-MAX_RUN).map((s) => s.cond);
      const blocked = last.length === MAX_RUN && last.every((c) => c === last[0]) ? last[0] : null;
      const cands: { id: string; cond: Cond }[] = [];
      for (const id of ids) {
        if (done.has(id)) continue;
        const at = placedAt.get(id);
        const f = first.get(id)!;
        const c: Cond | null = at === undefined ? f : seq.length - at >= MIN_GAP ? (f === 'on' ? 'off' : 'on') : null;
        if (c && c !== blocked) cands.push({ id, cond: c });
      }
      if (cands.length === 0) break;
      const pick = cands[Math.floor(rng() * cands.length)];
      if (placedAt.has(pick.id)) done.add(pick.id);
      else placedAt.set(pick.id, seq.length);
      seq.push(pick);
    }
    if (seq.length === ids.length * 2) return seq;
  }
  // 制約を満たせない場合（本数が少ないなど）は単純にシャッフル
  return shuffle(
    ids.flatMap((id) => [
      { id, cond: 'on' as Cond },
      { id, cond: 'off' as Cond },
    ]),
    rng,
  );
}

function makeBlocks(warp: WarpField, area: CalibArea, map: CalibMap): Block[] {
  const rng = seededRng(SEED);
  const L = Math.max(area.left, 0) + MARGIN;
  const T = Math.max(area.top, 0) + MARGIN;
  const R = Math.min(area.left + area.width, window.innerWidth) - MARGIN;
  const B = Math.min(area.top + area.height, window.innerHeight) - MARGIN;
  const w = Math.max(R - L, 60);
  const h = Math.max(B - T, 60);
  const inside = (p: Pt) => p.x >= L && p.x <= L + w && p.y >= T && p.y <= T + h;
  const toDoc = (p: Pt): Pt => ({ x: (p.x - map.left) * map.scale, y: (p.y - map.top) * map.scale });
  let nextId = 1;

  /** want: 'in' = 学習範囲内（8 割以上が範囲内）, 'out' = 範囲外（2 割以下）, 'any' */
  const candidate = (kind: PathKind, want: 'in' | 'out' | 'any') => {
    let fallback: Omit<Spec, 'phase' | 'task' | 'cond' | 'rep'> | null = null;
    for (let k = 0; k < 400; k++) {
      const path = genPath(kind, L, T, w, h, rng);
      if (!path.every(inside)) continue;
      const doc = path.map(toDoc);
      const probe = doc.filter((_, i) => i % 5 === 0);
      const coverage = probe.filter((p) => warp.isCovered(p.x, p.y)).length / probe.length;
      const fieldMag =
        probe.reduce((s, p) => {
          const [dx, dy] = warp.displacementAt(p.x, p.y);
          return s + Math.hypot(dx, dy);
        }, 0) / probe.length;
      const c = { pathId: `P${nextId}`, kind, path, doc, inArea: coverage >= 0.5, coverage, fieldMag };
      fallback = fallback ?? c;
      if (want === 'any' || (want === 'in' && coverage >= 0.8) || (want === 'out' && coverage <= 0.2)) {
        nextId++;
        return c;
      }
    }
    nextId++;
    // 条件に合う経路が作れなかった（例: 学習範囲が画面全体を覆っている）。記録上の内/外はそのまま。
    return { ...fallback!, pathId: `P${nextId - 1}` };
  };

  const practice = (task: TaskKind): Spec[] =>
    shuffle([...KINDS], rng)
      .slice(0, PRACTICE)
      .map((kind) => ({
        ...candidate(kind, 'any'),
        phase: 'practice' as Phase,
        task,
        cond: (rng() < 0.5 ? 'on' : 'off') as Cond,
        rep: 1,
      }));

  const main = (task: TaskKind): Spec[] => {
    const cands = KINDS.flatMap((kind) =>
      Array.from({ length: PER_KIND }, (_, i) => candidate(kind, i < PER_KIND - OUT_PER_KIND ? 'in' : 'out')),
    );
    const byId = new Map(cands.map((c) => [c.pathId, c]));
    return orderPairs(
      cands.map((c) => c.pathId),
      rng,
    ).map(({ id, cond }) => ({ ...byId.get(id)!, phase: 'main' as Phase, task, cond, rep: 1 }));
  };

  const repeat = (): Spec[] => {
    const cands = KINDS.flatMap((kind) => Array.from({ length: REPEAT_PER_KIND }, () => candidate(kind, 'in')));
    // 同じお手本が続かないように並べる
    for (let attempt = 0; attempt < 500; attempt++) {
      const seq = shuffle(
        cands.flatMap((c) => Array.from({ length: REPEAT_REPS }, () => c)),
        rng,
      );
      if (seq.every((c, i) => i === 0 || seq[i - 1].pathId !== c.pathId)) {
        const reps = new Map<string, number>();
        return seq.map((c) => {
          const r = (reps.get(c.pathId) ?? 0) + 1;
          reps.set(c.pathId, r);
          return { ...c, phase: 'repeat' as Phase, task: 'trace' as TaskKind, cond: 'off' as Cond, rep: r };
        });
      }
    }
    return [];
  };

  return [
    { title: '練習（なぞり）', note: '操作に慣れるための練習です（集計しません）。', trials: practice('trace') },
    {
      title: '本番 A：なぞり',
      note: '緑の点（始点）から赤い丸（終点）まで、青い経路に沿ってなぞってください。',
      trials: main('trace'),
    },
    { title: '練習（記憶描き）', note: '操作に慣れるための練習です（集計しません）。', trials: practice('memory') },
    {
      title: '本番 B：記憶描き',
      note: '経路は 1.5 秒で消えます。始点と終点だけを頼りに、見た経路を思い出して描いてください。',
      trials: main('memory'),
    },
    {
      title: '繰り返し',
      note: '同じお手本が何回か出ます。毎回、経路に沿ってなぞってください（評価の入力はありません）。',
      trials: repeat(),
    },
  ];
}

/* ---------------------------------------------------------------- 表示用 */

const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '-');
const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '-');
const pct = (v: number) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(0)}%` : '-');

export function WarpTest({
  warp,
  area,
  map,
  docSize,
  onClose,
}: {
  warp: WarpField;
  area: CalibArea;
  map: CalibMap;
  /** キャンバスの大きさ（紙として描く範囲） */
  docSize: { width: number; height: number };
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLCanvasElement>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const blocks = useMemo(() => makeBlocks(warp, area, map), [warp, area, map]);
  const S = useRef({
    block: 0,
    trial: 0,
    stage: 'intro' as Stage,
    retries: 0,
    msg: '',
    records: [] as TrialRecord[],
    raw: [] as Pt[], // キャンバス座標（補正前）
    shown: [] as Pt[], // キャンバス座標（表示した線＝条件どおり補正後）
    t0: 0,
    t1: 0,
    pointerType: '',
    last: null as { x: number; y: number } | null,
    timer: 0,
    // 視点（開始時はエディタと同じ見え方）
    view: { tx: map.left, ty: map.top, z: 1 / map.scale, rot: 0 } as View,
    keys: { space: false, zoom: false, rot: false },
    gesture: null as ViewGesture | null,
  });
  const st = S.current;
  const spec = (): Spec | null => blocks[st.block]?.trials[st.trial] ?? null;
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
  /** その試行の条件で表示する位置（キャンバス座標）。エディタと同じく、回転中は変位を −θ 回す。 */
  const shownDocOf = (q: Pt, cond: Cond): Pt => {
    if (cond === 'off') return q;
    const [dx, dy] = warp.displacementAt(q.x, q.y);
    const th = (-st.view.rot * Math.PI) / 180;
    return {
      x: q.x + dx * Math.cos(th) - dy * Math.sin(th),
      y: q.y + dx * Math.sin(th) + dy * Math.cos(th),
    };
  };
  /** いまお手本の経路を見せる場面か（なぞり・記憶描きの提示中）。 */
  const pathVisible = () => {
    const sp = spec();
    return !!sp && (sp.task === 'trace' || st.stage === 'preview');
  };

  /* ------------------------------------------------------------ 描画 */

  const drawScene = (showPath: boolean) => {
    const c = sceneRef.current?.getContext('2d');
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
    const sp = spec();
    if (!sp || st.stage === 'intro' || st.stage === 'result') return;
    const p = sp.doc.map(toClient);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (showPath) {
      c.strokeStyle = 'rgba(0,150,255,.3)';
      c.lineWidth = 10;
      c.beginPath();
      c.moveTo(p[0].x, p[0].y);
      for (const q of p) c.lineTo(q.x, q.y);
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
    }
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
    // 描いている途中・描き終えた直後の線（視点を変えても描き直せるようキャンバス座標で持っている）
    if ((st.stage === 'drawing' || st.stage === 'hold') && st.shown.length > 1) {
      const q = st.shown.map(toClient);
      c.strokeStyle = '#111';
      c.lineWidth = 2.5;
      c.beginPath();
      q.forEach((r, i) => (i ? c.lineTo(r.x, r.y) : c.moveTo(r.x, r.y)));
      c.stroke();
    }
  };

  /** ペンを浮かせているときのカーソルも、その試行の条件どおりにゆがめて表示する。 */
  const drawCursor = (p: Pt | null) => {
    const c = cursorRef.current?.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const sp = spec();
    if (!p || !sp || st.gesture || !['preview', 'ready', 'drawing'].includes(st.stage)) return;
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
      drawScene(pathVisible());
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
    const sp = spec();
    if (!sp) return;
    if (sp.task === 'memory') {
      st.stage = 'preview';
      drawScene(true);
      rerender();
      st.timer = window.setTimeout(() => {
        if (st.stage !== 'preview') return;
        st.stage = 'ready';
        drawScene(false);
        rerender();
      }, PREVIEW_MS);
    } else {
      st.stage = 'ready';
      drawScene(true);
      rerender();
    }
  };

  const next = () => {
    st.retries = 0;
    st.msg = '';
    st.trial++;
    if (st.trial >= blocks[st.block].trials.length) {
      st.block++;
      st.trial = 0;
      while (st.block < blocks.length && blocks[st.block].trials.length === 0) st.block++;
      setStage(st.block >= blocks.length ? 'result' : 'intro');
      drawScene(false);
      return;
    }
    beginTrial();
  };

  const finishStroke = () => {
    const sp = spec()!;
    const rawDoc = st.raw;
    if (rawDoc.length < 3 || polyLength(rawDoc) < polyLength(sp.doc) * 0.5) {
      st.retries++;
      st.msg = '短すぎました。始点から終点まで描いてください（同じお手本でやり直します）';
      setStage('hold');
      st.timer = window.setTimeout(beginTrial, 700);
      return;
    }
    const shownDoc = st.shown; // 描いた時点の視点で補正して表示した線
    const shown = strokeMetrics(shownDoc, sp.doc);
    const raw = sp.cond === 'on' ? strokeMetrics(rawDoc, sp.doc) : shown;
    const dur = Math.max(1, st.t1 - st.t0);
    st.records.push({
      seq: st.records.length + 1,
      phase: sp.phase,
      task: sp.task,
      pathId: sp.pathId,
      kind: sp.kind,
      cond: sp.cond,
      rep: sp.rep,
      retries: st.retries,
      inArea: sp.inArea,
      coverage: sp.coverage,
      fieldMag: sp.fieldMag,
      pathLen: polyLength(sp.doc),
      shown,
      rawMeanDev: raw.meanDev,
      rawEndErr: raw.endErr,
      durationMs: dur,
      speed: (polyLength(rawDoc) / dur) * 1000,
      rating: null,
      smooth: warp.params.smooth,
      strength: warp.params.strength,
      scale: 1 / st.view.z,
      rotation: st.view.rot,
      pointerType: st.pointerType,
      time: new Date().toISOString(),
      raw: rawDoc,
      path: sp.doc,
    });
    st.msg = '';
    setStage('hold');
    st.timer = window.setTimeout(() => {
      drawScene(false);
      if (sp.phase === 'repeat') next();
      else setStage('rating');
    }, HOLD_MS);
  };

  const rate = (v: number) => {
    if (st.stage !== 'rating') return;
    st.records[st.records.length - 1].rating = v;
    next();
  };

  const toResult = () => {
    window.clearTimeout(st.timer);
    setStage('result');
    drawScene(false);
    drawCursor(null);
  };

  // テスト中はエディタのショートカットを止める。Esc = 中断して結果へ / 結果画面なら閉じる。1〜5 = 評価。
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    e.stopImmediatePropagation();
    if (setViewKey(e, true)) return;
    if (e.key === 'Escape') {
      if (st.stage === 'result') onClose();
      else if (window.confirm('テストを中断して、ここまでの結果を表示しますか？')) toResult();
    } else if (/^[1-5]$/.test(e.key)) rate(Number(e.key));
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      setViewKey(e, false);
    };
    const blur = () => {
      st.keys = { space: false, zoom: false, rot: false };
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
  const setViewKey = (e: KeyboardEvent, down: boolean): boolean => {
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
  const redraw = () => {
    drawScene(pathVisible());
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

  // ホイール: Ctrl/⌘ ＋ ホイール＝ズーム、ホイールのみ＝移動（エディタと同じ）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (st.stage === 'drawing') return;
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

  /* ------------------------------------------------------------ 入力 */

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
    st.t0 = e.timeStamp;
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

  const block = blocks[st.block];
  const mainTotal = blocks.reduce((s, b) => s + b.trials.length, 0);
  const doneTotal = blocks.slice(0, st.block).reduce((s, b) => s + b.trials.length, 0) + st.trial;

  const result = useMemo(() => {
    if (st.stage !== 'result') return null;
    return {
      tasks: (['trace', 'memory'] as TaskKind[]).map((t) => analyzeTask(st.records, t)),
      repeat: analyzeRepeat(st.records, (x, y) => warp.displacementAt(x, y)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.stage]);

  const saveCsv = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([toCsv(st.records)], { type: 'text/csv' }));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    a.download = `warp-test-${stamp}.csv`;
    a.click();
  };

  const renderTask = (t: TaskAnalysis) => (
    <div key={t.task} className="warp-test-sec">
      <div className="warp-calib-h">
        {TASK_LABEL[t.task]}（お手本 {t.pairs} 組）
      </div>
      {t.pairs === 0 ? (
        <div className="muted">補正あり・なしが両方そろったお手本がありません。</div>
      ) : (
        <>
          <table className="warp-test-table">
            <thead>
              <tr>
                <th>指標</th>
                <th>補正なし</th>
                <th>補正あり</th>
                <th>差（あり−なし）[95%CI]</th>
                <th>変化率</th>
                <th>ありが良い割合</th>
              </tr>
            </thead>
            <tbody>
              {t.metrics.map((m) => (
                <tr key={m.key}>
                  <td>
                    {m.label}
                    {m.unit && <span className="muted">（{m.unit}）</span>}
                  </td>
                  <td>{f2(m.stat.meanOff)}</td>
                  <td>{f2(m.stat.meanOn)}</td>
                  <td>
                    {f2(m.stat.meanDiff)} [{f2(m.stat.ciLo)}, {f2(m.stat.ciHi)}]
                  </td>
                  <td>{pct(m.stat.pctChange)}</td>
                  <td>{pct(m.stat.winRate).replace('+', '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted">
            平均ズレの内訳：
            {[...t.byKind, ...t.byArea]
              .filter((g) => g.n > 0)
              .map((g) => `${g.label} ${f1(g.off)}→${f1(g.on)}px（${g.n}組）`)
              .join(' ／ ')}
          </div>
          <div>
            判定：平均ズレ 1 割以上減・CI が 0 をまたがない {t.verdict.dev ? '✓' : '×'} ／ 時間の悪化 1 割以内{' '}
            {t.verdict.time ? '✓' : '×'} ／ 評価が下がらない {t.verdict.rating ? '✓' : '×'}
          </div>
        </>
      )}
    </div>
  );

  const sp = spec();
  return (
    <div className="warp-calib" ref={rootRef}>
      <canvas
        ref={sceneRef}
        style={{ position: 'absolute', left: 0, top: 0, touchAction: 'none' }}
      />
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
        <b>補正の効果テスト</b>
        {block && st.stage !== 'result' && (
          <span>
            {block.title}　{Math.min(st.trial + 1, block.trials.length)} / {block.trials.length}
            <span className="muted">（全体 {doneTotal} / {mainTotal}）</span>
          </span>
        )}
        <span className="warp-calib-msg">
          {st.msg ||
            (st.stage === 'preview'
              ? '経路を覚えてください…'
              : st.stage === 'ready' && sp
                ? sp.task === 'memory'
                  ? '始点から終点まで、覚えた経路を描いてください'
                  : '始点から終点まで、経路に沿ってなぞってください'
                : '')}
        </span>
        {st.stage !== 'result' && (
          <span className="muted" title="Space / 中ボタン＝移動、Z＋上下ドラッグ・Ctrl＋ホイール＝ズーム、D＋ドラッグ＝回転（Shift で 15° 刻み）">
            {Math.round(st.view.z * 100)}% ／{' '}
            <span className="warp-test-rot" onClick={resetRotation} title="クリックで回転を 0° に戻す">
              {Math.round(st.view.rot)}°
            </span>{' '}
            ／ Space＝移動・Z＝ズーム・D＝回転
          </span>
        )}
        {st.stage === 'result' ? (
          <button onClick={onClose}>閉じる (Esc)</button>
        ) : (
          <button onClick={() => window.confirm('テストを中断して、ここまでの結果を表示しますか？') && toResult()}>
            中断して結果へ (Esc)
          </button>
        )}
      </div>

      {st.stage === 'intro' && block && (
        <div className="warp-calib-summary">
          <b>{block.title}</b>
          <div>{block.note}</div>
          {st.block === 0 && (
            <div className="muted">
              補正は開始時点のもので固定し、テスト中は学習しません。補正のあり・なしは 1 本ごとに
              ランダムに切り替わります（どちらかは表示しません）。結果はテストの最後に表示します。
              {warp.trialCount === 0 && ' ※まだキャリブレーションをしていないため、補正ありとなしは同じになります。'}
            </div>
          )}
          <div className="warp-calib-actions">
            <button
              className="primary"
              onClick={() => {
                beginTrial();
              }}
            >
              開始
            </button>
          </div>
        </div>
      )}

      {st.stage === 'rating' && (
        <div className="warp-calib-summary">
          <b>思い通りの線が引けましたか？</b>
          <div className="warp-test-rating">
            {RATING_LABELS.map((l, i) => (
              <button key={l} onClick={() => rate(i + 1)} title={l}>
                <b>{i + 1}</b>
                <span>{l}</span>
              </button>
            ))}
          </div>
          <div className="muted">数字キー 1〜5 でも答えられます。</div>
        </div>
      )}

      {st.stage === 'result' && result && (
        <div className="warp-calib-summary warp-test-result">
          <b>テスト結果</b>
          <div className="muted">
            記録 {st.records.length} 本（練習を含む）／ 補正の設定：なめらかさ λ={warp.params.smooth}・強さ{' '}
            {warp.params.strength}。ズレはキャンバス px、差は「補正あり − 補正なし」（平均ズレ等は負なら改善、評価は正なら改善）。
          </div>
          {result.tasks.map(renderTask)}
          <div className="warp-test-sec">
            <div className="warp-calib-h">直せるズレ / 直せないズレ（補正なしで同じお手本を {REPEAT_REPS} 回）</div>
            {result.repeat.paths === 0 ? (
              <div className="muted">繰り返しの記録がありません。</div>
            ) : (
              <>
                <div>
                  毎回同じ向きに出るクセ <b>{f1(result.repeat.sys)}px</b> ／ 毎回ばらばらのばらつき{' '}
                  <b>{f1(result.repeat.rand)}px</b> ／ ズレのうちクセの占める割合（場のゆがみで直せる上限）{' '}
                  <b>{pct(result.repeat.correctable).replace('+', '')}</b>
                </div>
                <div>
                  学習済みの補正をかけたと仮定したときに残るクセ {f1(result.repeat.sysAfter)}px（{result.repeat.paths} 本のお手本）
                </div>
              </>
            )}
          </div>
          <div className="warp-calib-actions">
            <button onClick={saveCsv}>CSV を保存</button>
            <button className="primary" onClick={onClose}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
