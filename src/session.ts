import type { BBox, EditorState, Operation } from './types';
import { applyOperation } from './engine/operation';
import { createInitialState } from './engine/editorState';
import './engine/operations'; // 操作ハンドラを登録
import { unionBBox } from './engine/geom';

/**
 * undo/redo で「表示上どこが変わったか」を region で確実に囲める op のクラス（画素をその場で書き換える）。
 * brush（ストローク bbox）と color（明度/色相/塗り = レイヤ内容 bbox）は region 内で完結する。
 * rigid/deform（移動・回転・拡大＝内容の移動を伴う）は op.region が移動元を含まないことがあり、
 * 部分再描画だと元位置に取り残しが出るため対象外。edit（構造変化）も region が表示差分を保証しないので対象外。
 * これらは null を返して全面再描画にフォールバックする（安全側）。
 */
const PIXEL_LOCAL_KLASSES = new Set(['brush', 'color']);

/** ops の region 和集合。全 op が画素ローカルで region を持つ場合のみ返し、そうでなければ null（＝全面）。 */
function changedRegion(ops: readonly Operation[]): BBox | null {
  if (ops.length === 0) return null;
  let acc: BBox | null = null;
  for (const op of ops) {
    if (!PIXEL_LOCAL_KLASSES.has(op.klass) || !op.region) return null;
    acc = acc ? unionBBox(acc, op.region) : op.region;
  }
  return acc;
}

/**
 * Undo/Redo の履歴エントリ。log は常に保持し、state は直近のみ参照を保持する
 * （state が null のエントリは log から replay で復元する。メモリと速度のトレードオフ）。
 */
interface HistoryEntry {
  log: Operation[];
  state: EditorState | null;
}

/** 編集状態と Undo/Redo を管理する。古い履歴は内部の操作記録から復元する。 */
export class EditorSession {
  state: EditorState;
  private log: Operation[] = [];
  width: number;
  height: number;

  /** apply() で 1 op を確定した直後に呼ばれる任意フック（将来の拡張・通知用）。 */
  onApply?: (op: Operation) => void;

  /**
   * 直近の undo/redo で変化した表示領域の近似（部分再描画用）。null = 全面再描画が必要
   * （構造変化や region 不明のとき）。undo()/redo() が true を返した直後に読む。
   */
  lastDirtyRegion: BBox | null = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private static readonly MAX_UNDO = 200;
  private static readonly MAX_CACHED_STATES = 24;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.state = createInitialState(width, height);
  }

  apply(op: Operation): EditorState {
    this.pushSnapshot(this.undoStack);
    this.redoStack = [];
    this.state = applyOperation(this.state, op);
    this.log.push(op);
    this.onApply?.(op);
    return this.state;
  }

  /** 複数 op を 1 回の undo 単位として適用する（空なら何もしない）。 */
  applyBatch(ops: readonly Operation[]): EditorState {
    if (ops.length === 0) return this.state;
    this.pushSnapshot(this.undoStack);
    this.redoStack = [];
    for (const op of ops) {
      this.state = applyOperation(this.state, op);
      this.log.push(op);
    }
    return this.state;
  }

  /**
   * 直前に apply した操作を newOp で置き換え、状態を newState へ直接差し替える。
   * 変形ツールが連続ジェスチャを1操作へ統合する際、全ログ replay を避けるための軽量経路。
   * 呼び出し側は newState が置換後の操作に対応することを保証する。undoStack は据え置き。
   */
  amendLast(newOp: Operation, newState: EditorState): void {
    if (this.log.length === 0) return;
    this.log[this.log.length - 1] = newOp;
    this.redoStack = [];
    this.state = newState;
  }

  private pushSnapshot(stack: HistoryEntry[]): void {
    stack.push({ log: [...this.log], state: this.state });
    const evict = stack.length - 1 - EditorSession.MAX_CACHED_STATES;
    if (evict >= 0 && stack[evict].state) stack[evict].state = null;
    if (stack.length > EditorSession.MAX_UNDO) stack.shift();
  }

  private applySnapshot(entry: HistoryEntry): void {
    this.log = [...entry.log];
    if (entry.state) {
      this.state = entry.state;
    } else {
      let s = createInitialState(this.width, this.height);
      for (const op of entry.log) s = applyOperation(s, op);
      this.state = s;
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    // prev.log は現ログの接頭辞（apply は末尾追加のみ）。取り消される op = 末尾差分。
    this.lastDirtyRegion = changedRegion(this.log.slice(prev.log.length));
    this.pushSnapshot(this.redoStack);
    this.applySnapshot(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    // 再適用される op = next.log の末尾差分。
    this.lastDirtyRegion = changedRegion(next.log.slice(this.log.length));
    this.pushSnapshot(this.undoStack);
    this.applySnapshot(next);
    return true;
  }

  getLog(): readonly Operation[] {
    return this.log;
  }

  /** 完全初期化（白紙）。 */
  reset(): void {
    this.state = createInitialState(this.width, this.height);
    this.log = [];
    this.undoStack = [];
    this.redoStack = [];
  }
}
