// ブラウザ向けの最小 Node `util` シム。
// ag-psd の一部デバッグ経路（例: 生成AI/コンテンツクレデンシャル "CAI " ブロックの読み取り）が
// `require('util').inspect(...)` を呼ぶ。ブラウザには util が無く Vite が externalize するため、
// そのまま到達すると実行時エラーになり該当 PSD の読み込みが失敗する。inspect だけ用意して回避する。
export function inspect(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default { inspect };
