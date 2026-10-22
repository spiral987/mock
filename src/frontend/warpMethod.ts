/**
 * 実験方式（2 種類だけ）。
 *   A: キャンバス固定・視点操作なし … 補正場はキャンバス座標（位置・向き・大きさ＝キャンバス px）。
 *      エディタ・学習・効果測定のどこでも、回転・パン・ズームを使わない。
 *   B: 入力座標系固定・視点操作あり … 補正場は画面上の入力座標（ブラウザの clientX/Y、画面 px）。
 *      回転・パン・ズームをしても、画面上の同じ入力位置には同じ変位がかかる。
 *      板タブの物理座標ではない（ブラウザからは取得できない）。
 */
export type WarpMethod = 'A' | 'B';
export const WARP_METHOD_LABEL: Record<WarpMethod, string> = {
  A: 'A：キャンバス固定・視点操作なし',
  B: 'B：入力座標系固定・視点操作あり',
};
export const WARP_METHOD_HINT: Record<WarpMethod, string> = {
  A: '補正はキャンバスに貼り付く（位置・向き・大きさはキャンバス基準）。回転・パン・ズームは使えません。',
  B: '補正は画面上の入力位置に貼り付く（ブラウザの画面座標。板タブの物理座標ではありません）。回転・パン・ズームしても、同じ画面位置には同じ補正がかかります。',
};
const METHOD_KEY = 'mock.warpMethod';
export function loadWarpMethod(): WarpMethod {
  try {
    return localStorage.getItem(METHOD_KEY) === 'B' ? 'B' : 'A';
  } catch {
    return 'A';
  }
}
export function saveWarpMethod(m: WarpMethod): void {
  try {
    localStorage.setItem(METHOD_KEY, m);
  } catch {
    /* 保存できなくても動く */
  }
}
