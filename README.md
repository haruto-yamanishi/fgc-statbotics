# FGC Stats

FIRST Global Challenge の公開結果 API を使った、対戦表・試合予測・チーム分析の非公式ダッシュボードです。画面は日本語です。

## できること

- 公開済み対戦表から、選択チームの次の試合と全試合の予定を表示
- 赤・青アライアンスの予測得点（Estimated Points）と予測勝率を表示
- 終了した試合の実得点、試合前予測、的中・不的中を表示
- 公式順位と、総合・試合本体・終盤それぞれの FGC EPA ランキングを表示
- チーム検索、試合検索、シーズン切り替え
- 60 秒ごとに公式データを再取得

2026 年の公式順位は大会開始前には空です。その間も対戦表から参加チームを作成し、2025 年と 2024 年の国別 EPA を基に暫定予測を計算します。過去年のチーム ID は変わるため、国コードで対応付けます。

初戦前の予測得点は過去 2 年の得点スケールを使う暫定値です。今年の結果が公開されると、今年の平均得点と直近 24 アライアンスの得点水準を取り込みます。予測結果の検証は試合順に行い、同時刻の試合結果は互いの予測に使いません。

FGC EPA はランキング戦のアライアンス得点からチームの寄与を加法モデルで推定します。2026 年の終盤得点は[公式ゲームマニュアル](https://docs.google.com/document/d/11uHfXaXqNHy9q4LvUZ5AduTErb12A0mZC6fgkDYeBf8/view)の登坂倍率による加点、パートナークライム、協力ボーナスから求めます。本体得点は公式得点から終盤得点を引いた値です。詳細データがない場合、内訳 EPA は表示しません。予測と EPA は参考値で、FIRST Global や Statbotics の公式指標ではありません。

## ローカルで起動

依存パッケージやビルドは不要です。

```bash
npm test
npm run serve
```

[http://localhost:8080](http://localhost:8080) を開いてください。 `index.html` を `file://` で直接開くとブラウザーの制限で API を取得できません。

## データ

[FIRST Global 公開結果 API](https://api.first.global/v1?year=2026&excludeMatchDetails=false) からブラウザーが直接読み込みます。

## 公開

GitHub Pages のワークフローを同梱しています。GitHub の **Settings → Pages → Source: GitHub Actions** を有効にすると `main` への push で公開できます。

## ライセンス

MIT。FIRST®、FIRST Global、Statbotics とは提携していません。
