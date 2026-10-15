/**
 * ツールアイコン（インライン SVG の線画）。
 *
 * 外部アイコンフォント/画像を持ち込まず、24×24 の viewBox に stroke="currentColor" で描く。
 * これで (1) ボタンの文字色（＝選択中は反転）にそのまま追従し、(2) ズームしても滲まず、
 * (3) 依存が増えない。塗りが要る部分だけ fill="currentColor" を使う。
 */

import type { ReactNode } from 'react';

export type ToolIconName =
  | 'brush'
  | 'gpen'
  | 'pencil'
  | 'airbrush'
  | 'eraser'
  | 'bucket'
  | 'lassoFill'
  | 'eyedropper'
  | 'line'
  | 'rect'
  | 'lassoSelect'
  | 'transform'
  | 'undo'
  | 'redo'
  | 'deselect'
  | 'layerAdd'
  | 'folderAdd'
  | 'clip'
  | 'mergeDown'
  | 'variantAdd'
  | 'variantCopy'
  | 'slotEmpty'
  | 'layerClear'
  | 'layerDelete'
  | 'blendMultiply'
  | 'visible'
  | 'hidden';

interface Props {
  name: ToolIconName;
  /** 表示サイズ(px)。既定 18。 */
  size?: number;
}

/** 各アイコンの中身（<svg> の子要素）。線は共通の stroke 属性を svg 側で指定する。 */
const PATHS: Record<ToolIconName, ReactNode> = {
  // 丸筆: 穂先が丸い筆で線を引いている形
  brush: (
    <>
      <path d="M4 20c0-3 1.5-4 3-4.5" />
      <path d="M7.5 15.5c1.6-.4 3 .6 3.2 2.2.2 1.4-.9 2.6-2.5 2.8-1.7.2-3.4-.2-4.2-.5.9-.6 1.3-1.4 1.4-2.4" />
      <path d="M11 16.5 20.2 6.4a1.9 1.9 0 0 0-2.7-2.7L7.4 12.9" />
    </>
  ),
  // Gペン: 割れたペン先（スリット入り）
  gpen: (
    <>
      <path d="M4 20.5 6 15l9.6-10.6a1.8 1.8 0 0 1 2.6 2.6L8 16.9z" />
      <path d="M6 15l2.1 1.9" />
      <path d="m13.6 6.6 3 2.8" />
    </>
  ),
  // 鉛筆: 六角軸＋削った先端
  pencil: (
    <>
      <path d="M3.5 20.5 5 16l11-11 3.5 3.5-11 11z" />
      <path d="m14.4 6.6 3.5 3.5" />
      <path d="M5 16l3.5 3.5" />
    </>
  ),
  // エアブラシ: 噴き出す霧
  airbrush: (
    <>
      <path d="M13 5.5 20.5 13l-5 5-7.5-7.5z" />
      <path d="m8 10.5-4 4 5 5 4-4" />
      <circle cx="5" cy="5" r="1" />
      <circle cx="9.5" cy="3.5" r="1" />
      <circle cx="4" cy="9.5" r="1" />
    </>
  ),
  // 消しゴム: 傾いた消しゴムと台紙
  eraser: (
    <>
      <path d="M8.5 20.5 3.6 15.6a2 2 0 0 1 0-2.8l9-9a2 2 0 0 1 2.8 0l5 5a2 2 0 0 1 0 2.8l-8 8z" />
      <path d="m8.2 8.2 6.6 6.6" />
      <path d="M8.5 20.5H21" />
    </>
  ),
  // 塗りつぶし: 傾けたバケツと落ちる雫
  bucket: (
    <>
      <path d="M11.5 3.5 20 12l-7.5 7.5a1.6 1.6 0 0 1-2.3 0L4 13.3a1.6 1.6 0 0 1 0-2.3z" />
      <path d="m7.7 7.3 3.6 3.6" />
      <path d="M20.5 15c1 1.4 1.5 2.4 1.5 3a1.5 1.5 0 0 1-3 0c0-.6.5-1.6 1.5-3z" fill="currentColor" stroke="none" />
    </>
  ),
  // 投げ縄塗り: 投げ縄の輪の中が塗られている
  lassoFill: (
    <>
      <path
        d="M12 3.6c4.4 0 7.6 2.6 7.6 5.9 0 2.6-2 4.8-5 5.6-1.3.3-2 .5-2.6 1.1"
        fill="none"
      />
      <path d="M12 3.6C7.6 3.6 4.4 6.2 4.4 9.5c0 2.2 1.4 4.1 3.6 5.2" fill="none" />
      <path
        d="M12 5.4c3.4 0 5.8 1.9 5.8 4.1s-2.4 4.1-5.8 4.1-5.8-1.9-5.8-4.1S8.6 5.4 12 5.4z"
        fill="currentColor"
        opacity=".35"
        stroke="none"
      />
      <path d="M8 14.7c-.8 1.4-.4 2.9.9 3.4 1 .4 1.9-.1 1.9-1 0-.7-.5-1.1-1.1-1.1-.5 0-.9.3-.9.8" />
      <path d="M9.6 20.4c1.6.4 3.2 0 4.2-1" />
    </>
  ),
  // スポイト
  eyedropper: (
    <>
      <path d="m16.5 3.5 4 4-2 2-4-4z" />
      <path d="m14 6 4 4-8.4 8.4-4.6 1.2 1.2-4.6z" />
      <path d="m11.5 8.5 4 4" />
    </>
  ),
  // 直線
  line: <path d="M4 20 20 4" />,
  // 矩形
  rect: <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />,
  // 投げ縄選択: 破線の輪＋垂れた紐
  lassoSelect: (
    <>
      <path
        d="M12 3.6c4.4 0 7.6 2.6 7.6 5.9 0 2.6-2 4.8-5 5.6-1.3.3-2 .5-2.6 1.1"
        strokeDasharray="2.6 2.2"
      />
      <path d="M12 3.6C7.6 3.6 4.4 6.2 4.4 9.5c0 2.2 1.4 4.1 3.6 5.2" strokeDasharray="2.6 2.2" />
      <path d="M8 14.7c-.8 1.4-.4 2.9.9 3.4 1 .4 1.9-.1 1.9-1 0-.7-.5-1.1-1.1-1.1-.5 0-.9.3-.9.8" />
      <path d="M9.6 20.4c1.6.4 3.2 0 4.2-1" />
    </>
  ),
  // 変形: 四隅ハンドル付きの枠
  transform: (
    <>
      <path d="M6.5 6.5h11v11h-11z" />
      <rect x="3.5" y="3.5" width="3" height="3" fill="currentColor" />
      <rect x="17.5" y="3.5" width="3" height="3" fill="currentColor" />
      <rect x="3.5" y="17.5" width="3" height="3" fill="currentColor" />
      <rect x="17.5" y="17.5" width="3" height="3" fill="currentColor" />
    </>
  ),
  undo: (
    <>
      <path d="M4 9h10a5 5 0 0 1 0 10h-6" />
      <path d="M8 5 4 9l4 4" />
    </>
  ),
  redo: (
    <>
      <path d="M20 9H10a5 5 0 0 0 0 10h6" />
      <path d="m16 5 4 4-4 4" />
    </>
  ),
  // 選択解除: 破線の枠に斜線
  deselect: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2.4" />
      <path d="m8 16 8-8" />
    </>
  ),
  // ---- レイヤー操作 ----
  // 縦軸（重なり）の操作は「上下に積んだ板」、横軸（差分）の操作は「左右に並べた板」で描き分ける。
  // どちらの軸を触るボタンなのかがアイコンの形だけで分かるようにするため。

  // レイヤー追加: 1枚の板の奥にもう1枚、右上に＋
  layerAdd: (
    <>
      <rect x="3" y="10.5" width="12.5" height="9" rx="1.4" />
      <path d="M6.2 10.5V8a1.4 1.4 0 0 1 1.4-1.4H13" />
      <path d="M18.5 3.5v6M15.5 6.5h6" />
    </>
  ),
  // フォルダ作成: タブ付きフォルダ＋＋
  folderAdd: (
    <>
      <path d="M3.5 19.3V8.4a1.2 1.2 0 0 1 1.2-1.2h3.3l1.7 2.2h5.6a1.2 1.2 0 0 1 1.2 1.2v8.7a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z" />
      <path d="M19 3v5.5M16.2 5.7h5.6" />
    </>
  ),
  // クリッピング: 上のレイヤーが折れて、下地の板の中へ入る（行の ⤵ と同じ意味）
  clip: (
    <>
      <rect x="3.5" y="13.8" width="17" height="6.4" rx="1.3" />
      <path d="M6.5 4.5h9a2 2 0 0 1 2 2v4.3" />
      <path d="m14.4 8.3 3.1 3.2 3.1-3.2" />
    </>
  ),
  // 下のレイヤーと結合: 上の板が下の板へ落ちる
  mergeDown: (
    <>
      <rect x="4" y="3.5" width="16" height="5" rx="1.3" />
      <rect x="4" y="15.5" width="16" height="5" rx="1.3" />
      <path d="M12 10v3.6" />
      <path d="m9.4 11.6 2.6 2.6 2.6-2.6" />
    </>
  ),
  // 差分を増やす: 中身のある板の【横】に、空(破線)の板が増える
  variantAdd: (
    <>
      <rect x="2.5" y="6.5" width="8.5" height="11" rx="1.3" />
      <path d="M4.6 14.4c.9-2.6 2-3.9 3.4-3.9" />
      <rect x="13" y="6.5" width="8.5" height="11" rx="1.3" strokeDasharray="2.6 2.2" />
      <path d="M17.2 9.4v5.2M14.6 12h5.2" />
    </>
  ),
  // 差分を複製: 同じ中身の板が横に並ぶ
  variantCopy: (
    <>
      <rect x="2.5" y="6.5" width="8.5" height="11" rx="1.3" />
      <path d="M4.6 14.4c.9-2.6 2-3.9 3.4-3.9" />
      <rect x="13" y="6.5" width="8.5" height="11" rx="1.3" />
      <path d="M15.1 14.4c.9-2.6 2-3.9 3.4-3.9" />
    </>
  ),
  // 空スロット: 中身のある板の横に、何も入らない板（破線＋斜線）が並ぶ。
  // 「差分追加」の破線板に斜線を足したもの＝「増えるのは中身ではなく“無い”という選択肢」。
  slotEmpty: (
    <>
      <rect x="2.5" y="6.5" width="8.5" height="11" rx="1.3" />
      <path d="M4.6 14.4c.9-2.6 2-3.9 3.4-3.9" />
      <rect x="13" y="6.5" width="8.5" height="11" rx="1.3" strokeDasharray="2.6 2.2" />
      <path d="m14.6 16 6.3-8" />
    </>
  ),
  // 表示中: 目
  visible: (
    <>
      <path d="M2.5 12s3.6-6 9.5-6 9.5 6 9.5 6-3.6 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  // 非表示: 目に斜線
  hidden: (
    <>
      <path d="M4 8.2C2.9 9.4 2.5 12 2.5 12s3.6 6 9.5 6c1.6 0 3-.3 4.3-.9" />
      <path d="M19.4 15.6c1.4-1.3 2.1-3.6 2.1-3.6S17.9 6 12 6c-.7 0-1.4.1-2 .2" />
      <path d="m4 20 16-16" />
    </>
  ),
  // 削除: ごみ箱
  layerDelete: (
    <>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 6.5l.9 12.3a1.7 1.7 0 0 0 1.7 1.7h5.8a1.7 1.7 0 0 0 1.7-1.7l.9-12.3" />
      <path d="M10.4 10v7M13.6 10v7" />
    </>
  ),
  // 乗算: 薄いインクを2枚重ねると、重なった所だけ濃くなる（＝掛け算）
  blendMultiply: (
    <>
      <circle cx="9.4" cy="12" r="5.6" fill="currentColor" opacity=".3" stroke="none" />
      <circle cx="14.6" cy="12" r="5.6" fill="currentColor" opacity=".3" stroke="none" />
      <circle cx="9.4" cy="12" r="5.6" />
      <circle cx="14.6" cy="12" r="5.6" />
    </>
  ),
  // 全消去: 板は残して中身だけ空にする
  layerClear: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.6" strokeDasharray="3 2.4" />
      <path d="m9 9.5 6 5M15 9.5l-6 5" />
    </>
  ),
};

export function ToolIcon({ name, size = 18 }: Props) {
  return (
    <svg
      className="tool-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
