# Sunday Obsidian Bridge

個人用AIアシスタント「Sunday」の自宅サーバーと、Obsidian の `Sunday/` フォルダのノートを同期するプラグインです（作者本人の利用のためのもので、一般向けではありません）。

- サーバーから同期命令を取りに行き、`Sunday/` 配下のノートを作成・更新します。
- 利用者メモ・追加したタグ・タスクのチェックだけをサーバーへ返します。
- `Sunday/` の外のノートは、`sunday_import: true` を付けたものだけを読みます。

## 導入（iPhone / iPad）

1. コミュニティプラグインから「BRAT」を入れて有効にする。
2. BRAT の「Add Beta plugin」にこのリポジトリ（`Fuku484/sunday-obsidian-bridge`）を入れる。
3. 「Sunday Obsidian Bridge」を有効にし、設定画面でサーバーのURLと端末トークンを入れる。
