import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { KIND_LABEL, type OptResult, type PathKind, type Pt, type Tendency, type WarpField } from './warpField';
import { genPath, resample } from './warpPaths';

/**
 * 場のゆがみ補正のキャリブレーション（描画とは分離した学習タスク）。
 *
 * 「始点・終点・経路」を指定したガイド（直線 / 円弧 / S字）を出し、なぞってもらう。
 * 経路がユーザの「理想の線」になるので、なぞった軌跡とのズレを WarpField に学習させる。
 * 1 セット終わるごとに、ズレ方の傾向を集計し、補正のかけ方（カーネル幅・強さ）を最適化する。
 * キャンバスには一切描かない。ガイドはキャンバスが見えている範囲に出す。
 * 場はキャンバス座標で持つので、画面座標 ⇄ キャンバス座標を map で変換して渡す。
 * 経路は短いと局所的に極端な歪みを学習しやすいので、見えている範囲に対して長めに取る。
 */

/** area: キャンバスが画面に見えている範囲（client px）。map: canvas = (client - left/top) · scale */
export type CalibArea = { left: number; top: number; width: number; height: number };
export type CalibMap = { left: number; top: number; scale: number };
type Trial = { kind: PathKind; rawErr: number; shownErr: number };
type Guide = { kind: PathKind; path: Pt[] };

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
  onClose,
}: {
  warp: WarpField;
  area: CalibArea;
  map: CalibMap;
  onClose: (trials: number) => void;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
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

  const newGuide = () => {
    // キャンバスの見えている範囲（画面内に収まる部分）に経路を置く
    const L = Math.max(area.left, 0) + MARGIN;
    const T = Math.max(area.top, 0) + MARGIN;
    const R = Math.min(area.left + area.width, window.innerWidth) - MARGIN;
    const B = Math.min(area.top + area.height, window.innerHeight) - MARGIN;
    const w = Math.max(R - L, 60);
    const h = Math.max(B - T, 60);
    const inside = (p: Pt) => p.x >= L && p.x <= L + w && p.y >= T && p.y <= T + h;
    const kind = nextKind();
    for (let k = 0; k < 200; k++) {
      const path = genPath(kind, L, T, w, h);
      if (path.every(inside)) {
        guideRef.current = { kind, path };
        return;
      }
    }
    const cy = T + h / 2;
    guideRef.current = { kind: 'line', path: resample([{ x: L, y: cy }, { x: L + w, y: cy }]) };
  };

  const drawScene = () => {
    const c = ctx();
    if (!c) return;
    c.clearRect(0, 0, window.innerWidth, window.innerHeight);
    // 対象範囲（キャンバスの見えている部分）を紙として塗る
    c.fillStyle = '#fff';
    c.fillRect(area.left, area.top, area.width, area.height);
    const g = guideRef.current;
    if (!g || finishedRef.current) return;
    const p = g.path;
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
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, []);

  const toDoc = (p: Pt): Pt => ({ x: (p.x - map.left) * map.scale, y: (p.y - map.top) * map.scale });

  const addPoint = (x: number, y: number, pressure: number) => {
    const q = toDoc({ x, y });
    const [dx, dy] = warp.feed(q.x, q.y); // 変位はキャンバス px → 画面 px に戻して表示
    const sx = x + dx / map.scale;
    const sy = y + dy / map.scale;
    const s = strokeRef.current;
    const c = ctx();
    if (s && c) {
      c.lineCap = 'round';
      c.strokeStyle = 'rgba(230,60,60,.45)'; // 実際の手の軌跡
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(s.rx, s.ry);
      c.lineTo(x, y);
      c.stroke();
      c.strokeStyle = '#111'; // 補正後に表示される線
      c.lineWidth = 1 + 4 * pressure;
      c.beginPath();
      c.moveTo(s.sx, s.sy);
      c.lineTo(sx, sy);
      c.stroke();
    }
    strokeRef.current = { rx: x, ry: y, sx, sy };
  };
  const pressureOf = (e: PointerEvent | ReactPointerEvent) =>
    e.pointerType === 'mouse' ? 0.5 : e.pressure > 0 ? e.pressure : 0.5;

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (busyRef.current || finishedRef.current || e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても続行 */
    }
    warp.begin();
    strokeRef.current = null;
    addPoint(e.clientX, e.clientY, pressureOf(e));
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!strokeRef.current) return;
    const n = e.nativeEvent;
    const evs = typeof n.getCoalescedEvents === 'function' ? n.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [n]) addPoint(ev.clientX, ev.clientY, pressureOf(ev));
  };
  const onUp = () => {
    if (!strokeRef.current) return;
    strokeRef.current = null;
    const g = guideRef.current!;
    const r = warp.endTrace(g.path.map(toDoc), g.kind);
    busyRef.current = true;
    if (!r.ok) {
      setMsg('短すぎるため学習しませんでした（始点から終点までなぞってください）');
      setTimeout(() => {
        drawScene();
        busyRef.current = false;
      }, 500);
      return;
    }
    doneRef.current += 1;
    dirtyRef.current = true;
    setTrials((t) => [...t, { kind: g.kind, rawErr: r.rawErr, shownErr: r.shownErr }]);
    setMsg(`${KIND_LABEL[g.kind]}: 手のズレ ${f1(r.rawErr)}px → 補正後の線のズレ ${f1(r.shownErr)}px`);
    setTimeout(() => {
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
    <div className="warp-calib">
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
        <span className="muted">試行 {warp.trialCount}</span>
        <button onClick={close}>終了して描画に戻る (Esc)</button>
      </div>
      {finished && (
        <div className="warp-calib-summary">
          <div>
            <b>{BLOCK} 本 完了</b>　手のズレ {f1(avg(block, 'rawErr'))}px → 補正後の線のズレ{' '}
            {f1(avg(block, 'shownErr'))}px（前半 {f1(avg(block.slice(0, half), 'shownErr'))} → 後半{' '}
            {f1(avg(block.slice(half), 'shownErr'))}）
          </div>
          {renderAnalysis()}
          <div className="warp-calib-actions">
            <button
              disabled={!analysis}
              onClick={() => {
                setAnalysis(null);
                setBlockStart(trials.length);
                newGuide();
                setMsg('最適化した補正で続けてなぞってください');
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
