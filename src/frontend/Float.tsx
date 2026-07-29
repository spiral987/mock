import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * 折りたたみ可能なカテゴリ。ヘッダの +/− で開閉する（"+" で展開、"−" で折りたたみ）。
 */
export function Section({
  title,
  children,
  defaultOpen = true,
  right,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode; // ヘッダ右側に置く補助要素（任意）
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`fsec ${open ? 'open' : 'closed'}`}>
      <div className="fsec-head">
        <button className="fsec-toggle" onClick={() => setOpen((o) => !o)} title={open ? '折りたたむ' : '展開'}>
          {open ? '−' : '+'}
          <span className="fsec-title">{title}</span>
        </button>
        {right && <div className="fsec-right">{right}</div>}
      </div>
      {open && <div className="fsec-body">{children}</div>}
    </section>
  );
}

/**
 * 半透明のフロートウインドウ。タイトルバーをドラッグで移動、端（右辺/下辺/右下角）をドラッグで
 * リサイズできる。位置・サイズは localStorage に保存する。
 * 初期位置は defaultPos（left/right/top/bottom のいずれか）で指定する。
 */
export function FloatWindow({
  id,
  title,
  defaultPos,
  className,
  children,
}: {
  id: string;
  title: ReactNode;
  defaultPos: Pick<CSSProperties, 'left' | 'right' | 'top' | 'bottom'>;
  className?: string;
  children: ReactNode;
}) {
  const winRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; left: number; top: number } | null>(null);
  const resizeRef = useRef<{
    dir: string;
    sx: number;
    sy: number;
    w: number;
    h: number;
    left: number;
    top: number;
  } | null>(null);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => loadLS(`floatpos:${id}`, 'left', 'top'));
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => loadLS(`floatsize:${id}`, 'w', 'h'));

  // 保存済みの位置・サイズが現在のビューポート外に出ないようにクランプする。
  // マウント時（前回より小さい画面で開いた場合）とブラウザのリサイズ時に実行。
  // これがないと、ウインドウを縮小したときにタイトルバー（=タブ）が画面外へ出て見えなくなる。
  // ドラッグ/リサイズ中のクランプ（onMove / onResizeMove）と同じ余白（横80px・縦28px が残るように）。
  useEffect(() => {
    const clamp = () => {
      setSize((s) => {
        if (!s) return s;
        const w = Math.max(180, Math.min(window.innerWidth - 16, s.w));
        const h = Math.max(120, Math.min(window.innerHeight - 16, s.h));
        return w === s.w && h === s.h ? s : { w, h };
      });
      setPos((p) => {
        if (!p) return p; // 既定位置（アンカー）のままなら CSS 側で常に画面内
        const left = Math.max(0, Math.min(window.innerWidth - 80, p.left));
        const top = Math.max(0, Math.min(window.innerHeight - 28, p.top));
        return left === p.left && top === p.top ? p : { left, top };
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, []);

  // ---- 移動（タイトルバー） ----
  const onDown = (e: ReactPointerEvent) => {
    const rect = winRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, left: rect.left, top: rect.top };
    setPos({ left: rect.left, top: rect.top });
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      left: Math.max(0, Math.min(window.innerWidth - 80, d.left + (e.clientX - d.sx))),
      top: Math.max(0, Math.min(window.innerHeight - 28, d.top + (e.clientY - d.sy))),
    });
  };
  const onUp = () => {
    if (dragRef.current && winRef.current) {
      const r = winRef.current.getBoundingClientRect();
      localStorage.setItem(`floatpos:${id}`, JSON.stringify({ left: r.left, top: r.top }));
    }
    dragRef.current = null;
  };

  // ---- リサイズ（8方向ハンドル）。開始時に現在の位置・サイズを明示値に固定する ----
  const onResizeDown = (dir: string) => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = winRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = {
      dir,
      sx: e.clientX,
      sy: e.clientY,
      w: rect.width,
      h: rect.height,
      left: rect.left,
      top: rect.top,
    };
    setPos({ left: rect.left, top: rect.top }); // bottom 基準のウインドウも左上固定にする
    setSize({ w: rect.width, h: rect.height });
  };
  // 左辺(w)・上辺(n)は右辺・下辺を固定したまま位置(left/top)とサイズを同時に動かす。
  // 右辺(e)・下辺(s)は左上を固定してサイズだけ動かす（従来どおり）。
  const onResizeMove = (e: ReactPointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dx = e.clientX - r.sx;
    const dy = e.clientY - r.sy;
    const minW = 180;
    const minH = 120;
    const maxW = window.innerWidth - 16;
    const maxH = window.innerHeight - 16;
    let w = r.w;
    let h = r.h;
    let left = r.left;
    let top = r.top;
    if (r.dir.includes('e')) w = Math.max(minW, Math.min(maxW, r.w + dx));
    if (r.dir.includes('s')) h = Math.max(minH, Math.min(maxH, r.h + dy));
    if (r.dir.includes('w')) {
      const right = r.left + r.w; // 右辺を固定
      left = Math.max(0, Math.min(right - minW, r.left + dx));
      w = right - left;
      if (w > maxW) {
        w = maxW;
        left = right - w;
      }
    }
    if (r.dir.includes('n')) {
      const bottom = r.top + r.h; // 下辺を固定
      top = Math.max(0, Math.min(bottom - minH, r.top + dy));
      h = bottom - top;
      if (h > maxH) {
        h = maxH;
        top = bottom - h;
      }
    }
    setSize({ w, h });
    setPos({ left, top });
  };
  const onResizeUp = () => {
    if (resizeRef.current && winRef.current) {
      const r = winRef.current.getBoundingClientRect();
      localStorage.setItem(`floatsize:${id}`, JSON.stringify({ w: r.width, h: r.height }));
      // 左辺/上辺リサイズでは位置も動くので保存する。
      localStorage.setItem(`floatpos:${id}`, JSON.stringify({ left: r.left, top: r.top }));
    }
    resizeRef.current = null;
  };

  const style: CSSProperties = {
    ...(pos ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' } : { ...defaultPos }),
    ...(size ? { width: size.w, height: size.h } : {}),
  };

  return (
    <div ref={winRef} className={`float-window ${className ?? ''}`} style={style}>
      <div
        className="float-titlebar"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <span className="float-grip">⠿</span>
        {title}
      </div>
      <div className="float-content">{children}</div>
      {(['e', 's', 'w', 'n', 'se', 'sw', 'ne', 'nw'] as const).map((dir) => (
        <div
          key={dir}
          className={`float-resize float-resize-${dir}`}
          onPointerDown={onResizeDown(dir)}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeUp}
          onPointerCancel={onResizeUp}
        />
      ))}
    </div>
  );
}

function loadLS<A extends string, B extends string>(
  key: string,
  a: A,
  b: B,
): { [K in A | B]: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v && typeof v[a] === 'number' && typeof v[b] === 'number' ? v : null;
  } catch {
    return null;
  }
}
