# 🧪 Code-Lab ★ 司令室

AI開発チーム指揮シミュレーター。一人社長がAI従業員7名に開発指示を出し、アイソメトリックオフィスで作業する様子をリアルタイムにビジュアライズします。

## デモ

🔗 [GitHub Pages で遊ぶ](https://ailiber1.github.io/Code-Lab/)

## 機能

- **アイソメトリック3D風オフィス**: Canvas APIで描画されたオフィス俯瞰図
- **7名のAI従業員**: Phase別に自律的に動く開発チーム
- **6フェーズの開発フロー**: 設計→実装→レビュー→バグ修正→QA→デプロイ
- **デモモード**: 新作ゲーム開発ストーリーの自動再生
- **手動モード**: コマンド入力でAI従業員に指示
- **確認依頼システム**: 社長承認フロー
- **作業ログ**: ターミナル風リアルタイムログ

## 操作方法

| 操作 | 説明 |
|------|------|
| ▶ デモ | 自動デモモード（新作ゲーム開発） |
| 🎯 手動 | 手動モード（コマンド入力） |
| 速度ボタン | 1×/2×/4× で再生速度変更 |
| コマンドバー | 開発指示をテキスト入力 |
| 確認パネル | ✅承認 / ❌却下 / 💬返信 |

## 技術スタック

- HTML/CSS/JavaScript（単一ファイル）
- Canvas API（アイソメトリック2.5D描画）
- Google Fonts（Inter, Noto Sans JP, JetBrains Mono）
- 外部ライブラリなし（Pure JS）

## Phase 2: Claude Code連動（将来実装）

`CONNECTION_MODE` を `'websocket'` に変更し、Node.js中継サーバー（`server.js`）を追加することで、Claude Code CLIと連動したリアルタイム開発ビジュアライゼーションが可能になります。

```
Code-Lab/
├── index.html          ← アプリ本体
├── server.js           ← Phase 2: Node.js中継サーバー
├── log-watcher.js      ← Phase 2: Claude Codeログ監視
├── event-classifier.js ← Phase 2: ログ→エージェント分類
└── README.md
```
