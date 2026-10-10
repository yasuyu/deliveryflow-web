# Geminiの無料プランで勤務を振り返る

APIキーを設定しなくても、現在の無料の定型コメント・配達・履歴・ランキングは使えます。Geminiは任意機能です。費用を避けるため、無料プランを確認できない間は有効にしません。

## 先に無料プランを確認する

1. [Google AI Studioのプロジェクト](https://aistudio.google.com/projects)を開きます。
2. 使用するAPIキーが所属するプロジェクトの「請求階層」が **Free Tier** であることを確認します。「課金を設定 / Set up billing」は押しません。Tier 1以上や不明なプロジェクトのキーは使用しません。
3. [Google Cloudの課金](https://console.cloud.google.com/billing)でも、そのプロジェクトに請求先アカウントが関連付けられていないことを確認します。既存の課金プロジェクトや別用途の請求設定は変更せず、この用途には課金を設定していないプロジェクトを使います。
4. [公式料金表](https://ai.google.dev/gemini-api/docs/pricing)で`gemini-3.5-flash-lite`のStandard入力・出力がFree Tierで無料であること、[AI Studioの利用制限](https://aistudio.google.com/rate-limit)でそのプロジェクトの利用可否を確認します。利用できなければ、課金して上限を増やさず定型コメントを使います。

APIキーの文字列だけではアプリから請求階層を判定できません。`GEMINI_FREE_TIER_CONFIRMED`は運用者が上記を確認した記録であり、Googleの課金状態を自動検査・固定する仕組みではありません。確認できない場合は`false`を維持します。

無料モデルにもPaid Tierの料金があります。「無料のモデルを選んだ」だけでは費用ゼロの保証になりません。Google側で課金を有効にしないことが必要です。[Googleの課金説明](https://ai.google.dev/gemini-api/docs/billing)も確認してください。料金・プラン条件が変わったり状態が不明になったら、確認を`false`へ戻してアプリを再起動します。

## 確認後の設定

SQLite版は`.env`、PCのPostgreSQL版は`.env.postgres`、公開版はRenderのサーバー環境変数へ設定します。APIキーはGit・チャット・ブラウザーのコードに貼り付けません。

```dotenv
GEMINI_API_KEY=your-free-tier-api-key
GEMINI_FREE_TIER_CONFIRMED=true
```

SQLite版は`npm start`で再起動します。PCのPostgreSQL版は同じフォルダーで`npm run dev:postgres`を再起動し、環境変数を反映します。公開版のコード更新はPRのマージとRenderへの反映後に利用できます。この手順だけでデプロイやDB移行は行いません。

モデル・接続先は固定です。`OPENAI_API_KEY`・`OPENAI_MODEL`・`GEMINI_MODEL`による有料APIや別モデルへの切替はありません。APIキーと厳密な確認値`true`が両方なければ、AIボタンは未設定の案内を返し、外部通信しません。

## 送信内容と失敗時

ボタンを押したときだけ、確定した勤務時間（分）・配達件数・ポイントの3値を送信します。氏名・PIN・現在地・勤務日時・配達先・アカウントや勤務のIDは送りません。無料枠では送信内容と生成文がGoogleの製品改善に使われ、人が確認する場合があります。[利用条件](https://ai.google.dev/gemini-api/terms)を確認し、機密情報や個人情報を追加しないでください。

同じ勤務で外部生成は最大1回です。無料枠の上限、通信失敗、15秒のタイムアウト、拒否や未完了の応答時は生成失敗を表示し、有料APIへ切り替えたり自動で再生成したりしません。退勤の実績・ポイント・無料の定型コメントは保持します。過去の保存済みAI文章も引き続き読めます。

開発・自動テストはモック応答を使い、本物のAI APIへ接続しません。
