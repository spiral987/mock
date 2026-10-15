import { useRef, useState } from 'react';
import type { Operation } from '../types';
import { EditorSession } from '../session';
import { CanvasEditor } from './CanvasEditor';

// アートボード（＝最終画像になる矩形）の初期サイズ。
const BOARD_W = 900;
const BOARD_H = 600;

export function App() {
  // 現在のドキュメント（セッション）。サイズ変更や PSD 読込のたびに作り直し、key を変えて
  // CanvasEditor を再マウントして内部 state（pan/zoom/アクティブレイヤー）をリセットする。
  const genRef = useRef(0);
  const [doc, setDoc] = useState(() => ({
    session: new EditorSession(BOARD_W, BOARD_H),
    key: 'doc-0',
  }));

  // 編集のたびに version を進めて CanvasEditor へ再描画を促す（state は session が保持）。
  const [version, setVersion] = useState(0);
  const onEdit = () => setVersion((v) => v + 1);

  // 新しいサイズでセッションを作り直す（新規ドキュメント）。ops があれば 1 Undo 単位で初期適用する
  // （PSD 読込など）。CanvasEditor 側で内容破棄の確認を済ませてから呼ぶ。
  const newDocument = (w: number, h: number, ops?: readonly Operation[]) => {
    const session = new EditorSession(w, h);
    if (ops && ops.length) session.applyBatch(ops);
    genRef.current += 1;
    setDoc({ session, key: `doc-${genRef.current}` });
    setVersion((v) => v + 1);
  };

  const loadPsdDocument = (w: number, h: number, ops: readonly Operation[]) => newDocument(w, h, ops);

  return (
    <div className="app">
      <CanvasEditor
        key={doc.key}
        session={doc.session}
        width={doc.session.state.width}
        height={doc.session.state.height}
        version={version}
        onEdit={onEdit}
        onLoadPsdDocument={loadPsdDocument}
      />
    </div>
  );
}
