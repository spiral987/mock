import type { Attachment, BBox, LayerGroup, LayerNode, Operation, VariantState } from '../../types';
import type { OpHandler } from '../operation';
import { getNode } from '../editorState';
import {
  collectLeafIds,
  firstLeafId,
  isGroup,
  isVariantStack,
  shownLeafId,
  variantIndexOf,
} from '../layer';
import { genId } from '../../util/id';

/**
 * 状態 (state) と所属 (attachment) を操作する op 群（klass=edit）。
 *
 * モデル: 状態は名前を持つ対象で、スロットがそこにくっつく。所属は木の中には書かず
 * state.attachments という別の表に持つ。だからレイヤーを動かしても・統合しても・
 * フォルダに入れても関係の側は無傷で、「記録が指す先を失う」ことが起きない。
 *
 * 「保存」操作は無い（規則8）。くっつけた時点で参加している。
 * 状態を消せば付いていた所属が一斉に外れる（規則7）。
 *
 * すべて log に記録され replay で決定的に再構築できる（不変条件 state === replay(log)）。
 * 生成される id は params に焼き込む（replay 時も同一 id で再現するため）。
 */

const EMPTY: BBox = { x: 0, y: 0, w: 0, h: 0 };

// ---- 状態を作る -------------------------------------------------------------
export interface AddStateParams {
  stateId: string;
  name: string;
}

export const addStateHandler: OpHandler = {
  type: 'addState',
  klass: 'edit',
  apply(state, op) {
    const { stateId, name } = op.params as unknown as AddStateParams;
    const states = state.states ?? [];
    if (states.some((s) => s.id === stateId)) return state; // 冪等
    const next: VariantState = { id: stateId, name };
    return { ...state, states: [...states, next] };
  },
};

export function createAddStateOp(stateId: string, name: string): Operation {
  return {
    id: genId('addState'),
    type: 'addState',
    klass: 'edit',
    params: { stateId, name },
    region: EMPTY,
    layerId: stateId,
    timestamp: Date.now(),
  };
}

// ---- 状態を消す（付いていた所属が一斉に外れる。規則7） ----------------------
export interface RemoveStateParams {
  stateId: string;
}

export const removeStateHandler: OpHandler = {
  type: 'removeState',
  klass: 'edit',
  apply(state, op) {
    const { stateId } = op.params as unknown as RemoveStateParams;
    const states = state.states ?? [];
    if (!states.some((s) => s.id === stateId)) return state;
    return {
      ...state,
      states: states.filter((s) => s.id !== stateId),
      // 記録が消えるのではなく、関係が切れる。残ったスロットはそのまま並んでいる。
      attachments: (state.attachments ?? []).filter((a) => a.stateId !== stateId),
    };
  },
};

export function createRemoveStateOp(stateId: string): Operation {
  return {
    id: genId('removeState'),
    type: 'removeState',
    klass: 'edit',
    params: { stateId },
    region: EMPTY,
    layerId: stateId,
    timestamp: Date.now(),
  };
}

// ---- 状態の名前を変える ------------------------------------------------------
export interface RenameStateParams {
  stateId: string;
  name: string;
}

export const renameStateHandler: OpHandler = {
  type: 'renameState',
  klass: 'edit',
  apply(state, op) {
    const { stateId, name } = op.params as unknown as RenameStateParams;
    const states = state.states ?? [];
    if (!states.some((s) => s.id === stateId)) return state;
    return { ...state, states: states.map((s) => (s.id === stateId ? { ...s, name } : s)) };
  },
  // 絶対値セットなので連続適用は last-wins と等価。
  consolidate: (prev, next) =>
    prev.params.stateId === next.params.stateId
      ? { ...prev, params: next.params, timestamp: next.timestamp }
      : null,
};

export function createRenameStateOp(stateId: string, name: string): Operation {
  return {
    id: genId('renameState'),
    type: 'renameState',
    klass: 'edit',
    params: { stateId, name },
    region: EMPTY,
    layerId: stateId,
    timestamp: Date.now(),
  };
}

// ---- 所属をくっつける / 外す --------------------------------------------------
export interface SetAttachmentParams {
  stateId: string;
  /** 行（差分スタック）。 */
  stackId: string;
  /** その行の中のスロット。null なら所属を外す（＝この行ではどのスロットも選ばない）。 */
  slotId: string | null;
}

export const setAttachmentHandler: OpHandler = {
  type: 'setAttachment',
  klass: 'edit',
  apply(state, op) {
    const { stateId, stackId, slotId } = op.params as unknown as SetAttachmentParams;
    if (!(state.states ?? []).some((s) => s.id === stateId)) return state;
    const rest = (state.attachments ?? []).filter(
      (a) => !(a.stateId === stateId && a.stackId === stackId),
    );
    if (slotId === null) {
      // 外すだけ。スロットは残るので、後でまた同じ所へ付け直せる。
      return { ...state, attachments: rest };
    }
    // 指せるのは「行の中のスロット」だけ。任意のレイヤー id を通さないことがこの設計の要。
    const stack = getNode(state, stackId);
    if (!stack || !isVariantStack(stack)) return state;
    if (!stack.children.some((c) => c.id === slotId)) return state;
    const next: Attachment = { stateId, stackId, slotId };
    return { ...state, attachments: [...rest, next] };
  },
  // 同じ (状態, 行) への付け替えは絶対値セット。next だけを適用した結果と一致する
  // （next 側の filter が prev の寄与を必ず消すので、配列の順序まで同じになる）。
  consolidate: (prev, next) =>
    prev.params.stateId === next.params.stateId && prev.params.stackId === next.params.stackId
      ? { ...prev, params: next.params, timestamp: next.timestamp }
      : null,
};

export function createSetAttachmentOp(
  stateId: string,
  stackId: string,
  slotId: string | null,
): Operation {
  return {
    id: genId('setAttachment'),
    type: 'setAttachment',
    klass: 'edit',
    params: { stateId, stackId, slotId },
    region: EMPTY,
    layerId: stackId,
    timestamp: Date.now(),
  };
}

// ---- 状態を出す（所属している行を一斉に切り替える） --------------------------

/**
 * 状態を選ぶ、が 1 操作で済むのがこの設計の狙い。所属している行だけが一斉に動き、
 * スロットが 1 つの行（＝自動共有）は動かない。付いていない行も動かない（規則4）。
 *
 * 変わるのは各スタックの variantIndex だけで、木の形も画素も触らない。
 */
export interface ApplyStateParams {
  stateId: string;
}

export const applyStateHandler: OpHandler = {
  type: 'applyState',
  klass: 'edit',
  apply(state, op) {
    const { stateId } = op.params as unknown as ApplyStateParams;
    const want = new Map<string, string>(); // stackId -> slotId
    for (const a of state.attachments ?? []) {
      if (a.stateId === stateId && !want.has(a.stackId)) want.set(a.stackId, a.slotId);
    }
    if (want.size === 0) return state;

    // 差分が引っ込んだスタックを覚えておき、描き先を見失わせないよう後で付け替える。
    const swapped: { before: LayerGroup; after: LayerGroup }[] = [];
    const walk = (nodes: LayerNode[]): LayerNode[] =>
      nodes.map((n) => {
        if (!isGroup(n)) return n;
        const g: LayerGroup = { ...n, children: walk(n.children) };
        if (isVariantStack(g)) {
          const slotId = want.get(g.id);
          if (slotId !== undefined) {
            const at = g.children.findIndex((c) => c.id === slotId);
            if (at >= 0 && at !== variantIndexOf(g)) {
              g.variantIndex = at;
              swapped.push({ before: n, after: g });
            }
          }
        }
        return g;
      });

    const layers = walk(state.layers);
    if (swapped.length === 0) return state; // すでにその状態が出ている
    let activeLayerId = state.activeLayerId;
    for (const { before, after } of swapped) {
      if (collectLeafIds(before).includes(activeLayerId)) {
        // 出てきたのが空スロットならリーフが無いので、木のどこかへ逃がす（描いても何も出ない状態を避ける）。
        activeLayerId = shownLeafId(after) ?? firstLeafId(layers) ?? activeLayerId;
      }
    }
    return { ...state, layers, activeLayerId };
  },
  // 状態の切り替え連打は last-wins（各回が絶対値セットで、途中の状態を経由しても結果は同じ）。
  consolidate: (prev, next) =>
    prev.params.stateId === next.params.stateId
      ? { ...prev, params: next.params, timestamp: next.timestamp }
      : null,
};

export function createApplyStateOp(stateId: string, region?: BBox): Operation {
  return {
    id: genId('applyState'),
    type: 'applyState',
    klass: 'edit',
    params: { stateId },
    region: region ?? EMPTY,
    layerId: stateId,
    timestamp: Date.now(),
  };
}
