import type { Attachment, EditorState, LayerGroup, LayerNode, VariantState } from '../types';
import { getNode, getParentInfo } from './editorState';
import { isGroup, isVariantStack, variantIndexOf } from './layer';

/**
 * 状態 (state) と所属 (attachment) の読み出し側。すべて純関数で、state を書き換えない
 * （書き換えは operations/stateOps.ts の op 経由のみ）。
 *
 * 設計の核: 状態はレイヤーを指さず、**行の中のスロット**を指す。ここの関数は全部
 * 「その行のどのスロットか」を問う形になっていて、レイヤー id を引数に取る口が無い。
 *
 * 迷子の所属（スロットが消えた・別の行へ移った）は**取り除かずに読み飛ばす**。
 * 消す側で追いかけると op が増えて replay の一致条件が広がるので、生きているかどうかは
 * 読むときに木を見て決める（liveAttachment）。
 */

export function listStates(state: EditorState): readonly VariantState[] {
  return state.states ?? [];
}

export function listAttachments(state: EditorState): readonly Attachment[] {
  return state.attachments ?? [];
}

export function findState(state: EditorState, stateId: string): VariantState | undefined {
  return listStates(state).find((s) => s.id === stateId);
}

/** ノード以下にある差分スタック（横軸を持つ行）を上から順に集める。 */
export function collectVariantStacks(nodes: readonly LayerNode[]): LayerGroup[] {
  const out: LayerGroup[] = [];
  const walk = (ns: readonly LayerNode[]) => {
    for (const n of ns) {
      if (!isGroup(n)) continue;
      if (isVariantStack(n)) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * (stateId, stackId) の所属のうち「生きている」もの。
 * stackId が実在する差分スタックで、slotId がその子として残っている場合だけ返す。
 */
export function liveAttachment(
  state: EditorState,
  stateId: string,
  stackId: string,
): Attachment | undefined {
  const a = listAttachments(state).find((x) => x.stateId === stateId && x.stackId === stackId);
  if (!a) return undefined;
  const stack = getNode(state, stackId);
  if (!stack || !isVariantStack(stack)) return undefined;
  return stack.children.some((c) => c.id === a.slotId) ? a : undefined;
}

/** その状態が持つ生きた所属だけを返す（迷子は落とす）。 */
export function liveAttachmentsOf(state: EditorState, stateId: string): Attachment[] {
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const a of listAttachments(state)) {
    if (a.stateId !== stateId || seen.has(a.stackId)) continue;
    const live = liveAttachment(state, stateId, a.stackId);
    if (live) {
      seen.add(a.stackId);
      out.push(live);
    }
  }
  return out;
}

/** その行（差分スタック）に所属している状態を返す（1 スロットに複数の状態が付いていてよい）。 */
export function statesOnStack(state: EditorState, stackId: string): VariantState[] {
  return listStates(state).filter((s) => liveAttachment(state, s.id, stackId));
}

/**
 * その状態が「いまそのまま出ている」か。
 * 所属している全行が、その状態の選ぶスロットを表示していれば true。
 * 所属が 1 つも無い状態は（何も主張していないので）false —
 * これにより「どの状態でもない」を画面で言えるようになる。
 */
export function stateSatisfied(state: EditorState, stateId: string): boolean {
  const live = liveAttachmentsOf(state, stateId);
  if (live.length === 0) return false;
  return live.every((a) => {
    const stack = getNode(state, a.stackId) as LayerGroup;
    return stack.children[variantIndexOf(stack)]?.id === a.slotId;
  });
}

/**
 * 行 id が「状態 stateId の外」にあるか。
 * 上へ辿って差分スタックに出会うたび、その状態がそのスロットを選んでいるかを見る。
 * 選んでいない（別のスロットを選ぶ／どれも選ばない）なら、その中身は全部その状態の外。
 *
 * これがレールの「途切れ」の判定そのもの: 通っていない所は線を引かない。
 */
export function outsideState(state: EditorState, stateId: string, id: string): boolean {
  let cur = id;
  for (let guard = 0; guard < 128; guard++) {
    const info = getParentInfo(state, cur);
    if (!info || !info.parentId) return false;
    const parent = getNode(state, info.parentId);
    if (parent && isVariantStack(parent)) {
      const a = liveAttachment(state, stateId, parent.id);
      if (!a || a.slotId !== cur) return true;
    }
    cur = info.parentId;
  }
  return false;
}

/**
 * レールの 1 マス。行 × 状態の交点がどう見えるか。
 *   pass    … 素通り（スロットが 1 つしかない行 ＝ 全状態で自動共有。宣言も操作も要らない）
 *   dot     … 開いたスロットのうち、その状態が選んでいる 1 枚
 *   knobOn  … 畳んだスロット行。所属あり、かつ**いま出ているスロット**と一致
 *   knobOff … 畳んだスロット行。所属はあるが**別のスロット**を指している（＝ずれ）
 *   gap     … 線が途切れる（所属なし、またはその状態が選ばないスロットの中）
 */
export type RailCell = 'pass' | 'dot' | 'knobOn' | 'knobOff' | 'gap';

export function railCell(state: EditorState, stateId: string, rowId: string): RailCell {
  if (outsideState(state, stateId, rowId)) return 'gap';
  const node = getNode(state, rowId);
  if (!node) return 'gap';
  if (isVariantStack(node)) {
    const a = liveAttachment(state, stateId, node.id);
    if (!a) return 'gap'; // この行ではどのスロットも選んでいない（規則4）
    return node.children[variantIndexOf(node)]?.id === a.slotId ? 'knobOn' : 'knobOff';
  }
  // 開いたスロットの中の 1 枚で、その状態が選んでいる側なら点を打つ
  const info = getParentInfo(state, rowId);
  if (info?.parentId) {
    const parent = getNode(state, info.parentId);
    if (parent && isVariantStack(parent)) return 'dot';
  }
  return 'pass';
}

/**
 * その行がクリックで所属を付け外しできる場所か（＝スロットとして指せるか）。
 * 返り値は「どのスロットに付けるか」。畳んだスロット行はいま出ているスロット、
 * 開いたスロットの中の行はその行自身。
 */
export function attachTarget(
  state: EditorState,
  rowId: string,
): { stack: LayerGroup; slotId: string } | null {
  const node = getNode(state, rowId);
  if (!node) return null;
  if (isVariantStack(node)) {
    const slot = node.children[variantIndexOf(node)];
    return slot ? { stack: node, slotId: slot.id } : null;
  }
  const info = getParentInfo(state, rowId);
  if (!info?.parentId) return null;
  const parent = getNode(state, info.parentId);
  return parent && isVariantStack(parent) ? { stack: parent, slotId: rowId } : null;
}
