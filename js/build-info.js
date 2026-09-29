/**
 * このファイルは GitHub Actions のデプロイ時に実際のコミット SHA とビルド日時で
 * 上書きされる(.github/workflows/deploy-pages.yml 参照)。ローカル実行時は
 * このデフォルト値が使われる。
 */
window.BUILD_INFO = {
  sha: 'dev',
  time: 'ローカル環境',
};
