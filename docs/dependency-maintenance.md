# 依存パッケージの保守

2026-10-13の点検で、Prisma設定処理から利用するEffectとDeepmergeTSに既知の問題が見つかったため、PrismaとClientを6.19.3に固定しました。Effectはその標準依存の3.21.0を使います。Prisma設定が使うDeepmergeTSだけは`overrides`で8.0.0に固定しています。

- [Effectのアドバイザリ](https://github.com/advisories/GHSA-38f7-945m-qr2g)：3.20.0で修正済み。
- [DeepmergeTSのアドバイザリ](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)：8.0.0で循環参照によるスタック枯渇を修正。

DeepmergeTS 8にはMapのマージ方法などの変更があります。このアプリのPrisma設定は通常のオブジェクトと文字列を使い、Mapや独自のマージ関数は使いません。更新時はSQLite・PostgreSQLの設定読込、Schema検証、Client生成、Migration、APIテストを確認します。上流のPrismaが修正版を標準依存にした際は、個別のoverrideを取り除けるか確認してください。

`npm run audit:deps`で開発用を含む依存関係を検査します。既知のhigh・criticalがある場合は失敗し、CIでも同じ検査を行います。検査結果は実行時点の公表情報に基づき、アプリ全体に不具合がないことを保証するものではありません。
