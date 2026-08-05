import type { Operation } from '../types';

/** 操作の短い説明（ログパネル・Diff の操作リスト共通）。 */
export function describeOp(op: Operation): string {
  const p = op.params as Record<string, unknown>;
  switch (op.type) {
    case 'brush':
      return `${(p.brushType as string) ?? 'pen'} rgb(${(p.color as number[]).join(',')}) size${
        p.size
      } · ${op.strokes?.length ?? 0}pts`;
    case 'eraser':
      return `${(p.brushType as string) ?? 'pen'} 透明 size${p.size} · ${op.strokes?.length ?? 0}pts`;
    case 'translate':
      return `dx${p.dx} dy${p.dy}`;
    case 'brightness':
      return `Δ${p.delta}`;
    case 'hue':
      return `${p.shift}°`;
    case 'addLayer':
      return `${p.name}`;
    case 'addImageLayer':
      return `${p.name} (${p.imgWidth}×${p.imgHeight})`;
    case 'setLayerVisibility':
      return p.visible ? 'show' : 'hide';
    case 'setLayerOpacity':
      return `opacity ${Math.round((p.opacity as number) * 100)}%`;
    case 'renameLayer':
      return `→ "${p.name}"`;
    case 'removeLayer':
      return 'remove';
    case 'reorderLayer':
      return `→ index ${p.toIndex}`;
    case 'clearLayer':
      return 'clear';
    case 'mergeDownLayer':
      return 'merge down';
    case 'addGroup':
      return p.wrapLayerId ? `folder "${p.name}" (wrap)` : `folder "${p.name}"`;
    case 'moveNode':
      return p.parentId ? `→ into ${p.parentId}` : '→ top';
    case 'setGroupCollapsed':
      return p.collapsed ? 'collapse' : 'expand';
    case 'addVariant':
      return `${p.copy ? 'copy' : 'new'} variant "${p.name}"`;
    case 'setVariantIndex':
      return `slide → ${(p.index as number) + 1}`;
    case 'removeVariant':
      return 'remove variant';
    case 'moveAsVariant':
      return `${p.side === 'left' ? '←' : '→'} ${p.targetId} の差分へ`;
    case 'fill':
      return p.erase
        ? `透明 tol${p.tolerance}`
        : `rgb(${(p.color as number[]).join(',')}) tol${p.tolerance}`;
    case 'lassoFill': {
      const pts = ((p.path as number[])?.length ?? 0) / 2;
      return p.erase ? `透明 · ${pts}pts` : `rgb(${(p.color as number[]).join(',')}) · ${pts}pts`;
    }
    case 'setSelection': {
      const mode = (p.mode as string) ?? 'replace';
      const label =
        mode === 'add' ? '追加' : mode === 'subtract' ? '削除' : mode === 'intersect' ? '交差' : '新規';
      return `${label} · ${((p.path as number[])?.length ?? 0) / 2}pts`;
    }
    case 'clearSelection':
      return '選択解除';
    case 'transform': {
      const a = p.a as number;
      const b = p.b as number;
      const sx = Math.hypot(a, b);
      const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
      return `${sx.toFixed(2)}× ${deg}°`;
    }
    case 'baseline': {
      // base64 を含むので JSON 化はしない。畳み込んだリーフ数だけ示す。
      const countLeaves = (nodes: unknown[]): number =>
        nodes.reduce<number>((n, raw) => {
          const node = raw as { children?: unknown[] };
          return n + (node.children ? countLeaves(node.children) : 1);
        }, 0);
      const tree = (p.tree as unknown[]) ?? [];
      return `flatten · ${countLeaves(tree)} layers`;
    }
    default:
      return JSON.stringify(p);
  }
}
