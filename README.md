# mock

レイヤー型キャンバスエディタの素の土台。決定的な操作ログ（replay 可能）ベースの
描画エンジンと Tool UI を持つ。`canvas-scrap` から「レイヤーを枠外へ退避する実験
（park / 衛星キャンバス）」を取り除き、通常のレイヤー編集機能だけを残したもの。

## 機能

- ブラシ / 消しゴム / 塗りつぶし / スポイト / 直線 / 矩形 / Transform（移動・拡大縮小・回転）
- レイヤー・フォルダ（グループ）・クリッピングマスク・不透明度・表示切替・並べ替え（D&D）
- 画像 / PSD インポート（レイヤー・フォルダ・クリッピングを保持）、PNG 書き出し
- 非破壊のキャンバスサイズ変更、Undo/Redo、操作ログの replay 検証（Verify）
- ズーム / パン（視点移動）

エンジン（`src/engine`）とバックエンド（`src/backend`）は React / DOM に依存しない純 TS。

## 開発

```sh
npm install
npm run dev        # 開発サーバ
npm run build      # 型チェック + 本番ビルド
npm run typecheck  # 型チェックのみ
```
