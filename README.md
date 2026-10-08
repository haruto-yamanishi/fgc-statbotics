# FGC Stats

FIRST Global Challenge の公開結果 API を使った、対戦表・試合予測・チーム分析の非公式ダッシュボードです。画面は日本語です。

## できること

- 公開済み対戦表から、選択チームの次の試合と全試合の予定を表示
- 赤・青アライアンスの予測勝率と、データが集まった後の予測得点を表示
- 公式順位と独自指標 FGC EPA を表示
- チーム検索、試合検索、シーズン切り替え
- 60 秒ごとに公式データを再取得

2026 年の公式順位は大会開始前には空です。その間も対戦表から参加チームを作成し、2025 年と 2024 年の国別 EPA を基に暫定勝率を計算します。過去年のチーム ID は変わるため、国コードで対応付けます。今年の結果が増えると、今年の EPA を徐々に反映します。得点予測は今年のランキング戦が 6 試合以上終了してから表示します。予測は参考値で、FIRST Global や Statbotics の公式指標ではありません。

## ローカルで起動

依存パッケージやビルドは不要です。

```bash
npm test
npm run serve
```

[http://localhost:8080](http://localhost:8080) を開いてください。 `index.html` を `file://` で直接開くとブラウザーの制限で API を取得できません。

## データ

[FIRST Global 公開結果 API](https://api.first.global/v1?year=2026&excludeMatchDetails=true) からブラウザーが直接読み込みます。

## 公開

GitHub Pages のワークフローを同梱しています。GitHub の **Settings → Pages → Source: GitHub Actions** を有効にすると `main` への push で公開できます。

## ライセンス

MIT。FIRST®、FIRST Global、Statbotics とは提携していません。
