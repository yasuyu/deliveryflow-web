# DeliveryFlow Web

DeliveryFlowは、配達員の「勤務開始 → オファー確認 → 受諾 → 荷物受取 → 配達完了」をブラウザで試せる学習用Webアプリです。

すべて自分のPC内で無料で動かせます。普段の開発にはSQLite、本番に近い確認にはDocker ComposeとPostgreSQLを使います。

## できること

- 配達員の登録、6桁PINでのログイン、ログアウト
- 正しい状態遷移に沿った配達操作
- 配達履歴の検索と絞り込み
- 基本点、雨天・深夜ボーナス、称号、月間・14日間・全期間ランキング
- 明示的に許可した現在地から店舗までの直線距離、外部通信しない模式図、同意後に開く道路経路
- 店舗に近い順で最大N人へ同時に送るオファーと、先着1人の受諾確定
- 認証済みWebSocketによる状態変更の即時反映と、自動再接続・定期更新へのフォールバック
- SQLiteとPostgreSQLの両方で同じAPIを実行
- OpenAPI仕様、テスト、CIによる動作確認
- 京都の複数店舗・配達先から重複を避けて選ぶハッカソン再現用オファー
- ランキングと称号をすぐ確認できる、事前登録済みのデモ配達員と配達実績

## まず動かす

必要なものはNode.js 22以上とnpmです。PowerShellでリポジトリを開き、次を実行します。

```powershell
Copy-Item .env.example .env
npm ci
npm run db:migrate
npm run db:generate
npm start
```

起動後に開く場所:

- アプリ: <http://localhost:3000>
- API仕様: <http://localhost:3000/docs>
- ヘルスチェック: <http://localhost:3000/healthz>

ログイン後は、地図を広く見せる縮小状態から始まります。上部に配達状況と現在・累計スコア、下部に受取場所・配達先・座標・報酬と緑の主要操作ボタンを表示します。写真の京都クイックコマース画面を参考に、カードはアイボリーの背景と緑のアイコンで統一しています。

シートはハンドルのドラッグ、タップ、上下キーで縮小・中間・拡大の3段階にできます。詳細は広げたシートで確認でき、実績は上部スコア、設定は右上のメニューボタンからも開けます。

通常のシートには配達情報と主要操作だけを表示します。実績は上部のスコア、設定は右上のメニューから開き、各画面の「配達画面へ戻る」で復帰します。受諾・受取・完了などの主要操作は、詳細をスクロールしても下部に残ります。縮小時も案内と処理結果を確認でき、文章量に合わせて必要な高さを確保します。店舗・届け先は常に配達内容に表示し、オファー期限は受諾ボタンの近くに表示します。期限が切れると受諾ボタンを「最新の状況を確認する」へ切り替えます。

自動更新では同じ配達の詳細の開閉とフォーカスを保持します。シートは上下キー・Home・Endで操作できます。現在地・地図・天候・ログアウトは右上の「設定」、スコア・ランキング・履歴は上部のスコアから開きます。

## 京都の実地図

「実地図を表示する」を押すと、OpenStreetMapの地図を読み込みます。Leafletはnpmで固定バージョンを導入し、アプリと同じサーバーから配信します。地図表示にAPIキーや有料契約は不要です。

- 初期表示は京都市中心部（三条・鴨川周辺）。配達中は注文の受取場所と配達先を表示します。
- 現在地を更新すると、受取前は現在地から店舗を青、店舗から配達先を灰色、受取後は現在地から配達先を青い点線で表示します。いずれも直線で、道路に沿った経路計算や所要時間の算出は含みません。
- 地図を有効にすると、表示エリアのタイル情報とIPアドレスがOpenStreetMapへ伝わります。現在地を明示的に更新した後は、現在地を含む周辺の地図タイルを読み込み、地図上に現在地と進行方向を表示します。
- 地図はページを開くたびに表示を選びます。「設定」で通信を停止でき、ログアウト時にも停止します。通信できない場合も配達操作は使えます。
- 地図の出典を常に表示し、ブラウザのキャッシュを利用します。一括保存やオフライン用の事前取得は行いません。
- 無料の地図配信には稼働保証がありません。公開・利用拡大時は[OpenStreetMapの利用条件](https://operations.osmfoundation.org/policies/tiles/)を確認し、配信先を再検討します。

## 画面で試す順番

1. 認証画面で「新規登録」を選び、名前と6桁PINを入力して配達員を登録します。
2. 「稼働を開始する」を押します。
3. 必要なら「設定」の「現在地を更新する」を押し、ブラウザの位置情報を許可します。
4. 「オファーを確認する」を押します。
5. 配達詳細で、見込みスコア、直線距離、経路プレビューを確認します。
6. 受諾、荷物受取、配達完了の順に進めます。
7. 業務が終わったら退勤します。保存中の現在地はこの時点で削除されます。

雨天ボーナスは「設定」の「天候シミュレーター」で確認できます。外部の気象APIには接続しません。

## ハッカソン再現用デモ

このアプリは、店舗側の管理画面を持たず、配達員がオファーを受けて配達を完了する体験に絞っています。起動時に、既存データを変更せず、次の学習用データが不足している場合だけ自動で追加されます。

- 京都市中心部のデモ店舗5件
- 京都市内のデモ配達先10件と、地点ごとに異なる配達報酬
- ランキング表示専用のデモ配達員5人
- 実際の100・130・150・180ポイントの加点ルールで作った配達実績

新しいオファーは店舗と配達先の50通りから選びます。直近6件と同じ組み合わせを候補から外すため、短いデモ中に同じ経路が続きにくくなっています。

デモ配達員はランキングと称号の説明専用で、PINを持たずログインできません。自分のデモ用配達員は画面から登録してください。新規登録直後はランキング下位から始まり、配達完了による順位・スコア・称号進捗の変化を確認できます。

デモデータの追加処理は繰り返し実行しても重複しません。既存の配達員、注文、履歴、店舗は削除・初期化しません。

SQLite版のランキング用デモ実績だけを初期状態に戻す場合は、次を実行します。

```powershell
npm run demo:reset
```

PostgreSQL版では、Composeを起動した状態で次を実行します。

```powershell
docker compose --env-file .env.postgres exec app node scripts/demo-data.js --confirm-demo-reset
```

どちらのコマンドも、ランキング表示専用の5人に紐づく`ランキング実績`だけを作り直します。画面から登録した配達員、その注文・履歴・スコア、既存店舗は変更しません。

## ディレクトリ構成

写真の参考構成にならい、Web画面、サーバー、機能モジュール、DB、文書を分けています。

```text
deliveryflow-web/
├─ README.md                         最初に読む手順書
├─ AGENTS.md                         開発時のルール
├─ package.json                      npmコマンドと依存関係
├─ prisma.config.ts                  DB種別とSchemaの選択
├─ compose.yaml                      PostgreSQL版のローカル構成
├─ apps/
│  ├─ server/
│  │  ├─ Dockerfile                 APIコンテナ
│  │  ├─ docker-entrypoint.sh       コンテナ起動処理
│  │  ├─ src/
│  │  │  ├─ main.js                 API、認証、状態遷移
│  │  │  └─ modules/
│  │  │     ├─ location/            位置の保存と距離計算
│  │  │     ├─ matching/            店舗から近い候補者の選定
│  │  │     ├─ realtime/            WebSocket認証、配信、接続監視
│  │  │     └─ score/               スコアとボーナス計算
│  │  └─ test/                      API・機能テスト
│  └─ web/
│     ├─ public/                    HTML、CSS、ブラウザJS
│     │  └─ route-preview.js        経路模式図の生成
│     └─ test/                      ブラウザ用ロジックのテスト
├─ prisma/                           DB SchemaとMigration
├─ docs/
│  ├─ architecture.md               構成と責務の詳しい説明
│  ├─ workflow.md                   状態遷移と操作条件
│  ├─ data-model.md                 DBモデルと保存方針
│  ├─ decisions.md                  主な設計判断と理由
│  ├─ features.md                   機能IDと実装状況
│  ├─ demo.md                       画面デモの再現手順
│  ├─ performance.md                負荷試験と性能確認
│  ├─ openapi.yaml                  APIの契約書
│  ├─ PROJECT_STATUS.md             実装状況と次の候補
│  └─ HANDOFF.md                    新しいチャットへの引き継ぎ
└─ scripts/                          負荷試験・DB確認ツール
```

詳しい責務と、変更内容ごとに触る場所は [docs/architecture.md](docs/architecture.md) を参照してください。

## よく使うコマンド

| コマンド | 目的 |
|---|---|
| `npm start` | SQLite版アプリを起動 |
| `npm run check` | JavaScriptの構文を確認 |
| `npm test` | 一時DBで全自動テストを実行 |
| `npm run db:migrate` | SQLiteへMigrationを適用 |
| `npm run db:generate` | Prisma Clientを再生成 |
| `npm run db:studio` | SQLiteをPrisma Studioで確認 |
| `npm run dev:postgres` | PostgreSQL版をCompose Watchで起動 |
| `npm run studio:postgres` | PostgreSQLをPrisma Studioで確認 |
| `npm run demo:reset` | SQLite版のランキング用デモ実績だけを初期状態へ戻す |
| `npm run load-test` | ローカルのヘルスチェックへ負荷試験 |

## 設定ファイル

`.env`はPCごとのローカル設定です。Gitには保存されません。

```env
DATABASE_URL="file:./delivery.db"
PORT=3000
OFFER_TTL_SECONDS=120
OFFER_CANDIDATE_LIMIT=3
# SCORE_BONUS_SIMULATED_NOW="2026-09-14T22:00:00+09:00"
```

- `DATABASE_URL`: SQLiteファイルの場所。Prisma Schemaからの相対位置です。
- `PORT`: アプリのポート番号。
- `OFFER_TTL_SECONDS`: オファーが期限切れになるまでの秒数。
- `OFFER_CANDIDATE_LIMIT`: 1注文あたり同時にオファーを送る近い順の人数（初期値3）。
- `SCORE_BONUS_SIMULATED_NOW`: 深夜ボーナスを日中に試す場合だけ指定します。

## 現在地とプライバシー

位置情報は「現在地を更新する」を押したときだけブラウザへ要求します。自動追跡やバックグラウンド取得は行いません。

- 保存できるのは勤務中だけです。
- 勤務中に保存した最新位置は、更新時刻に関係なく候補選定と距離計算に使います。
- 店舗から近い順に最大`OFFER_CANDIDATE_LIMIT`人を候補にし、最初に受諾した1人へ確定します。残りのオファーは取り下げます。
- 退勤すると緯度・経度・精度・更新時刻をDBから削除します。
- API画面には配達員本人の正確な緯度・経度を返しません。
- 距離は外部地図へ送らず、サーバー内で直線距離として計算します。
- 配達詳細の経路プレビューも外部通信せず、地点の順番と直線距離だけを模式図として表示します。
- 配達詳細には、テスト注文の料金、店舗・届け先の学習用座標、現在の進行案内も表示します。
- 「実際の道路経路を確認」を押すと、確認画面を出したうえでOpenStreetMapを別タブで開きます。
- 現在地の座標をOpenStreetMapへ送るのは、「現在地 → 店舗」を選び、確認画面で同意した場合だけです。
- ブラウザーで取得した現在地は外部経路リンク用に永続保存せず、ページを閉じると失われます。
- 新しく作る店舗と届け先は京都市中心部の学習用仮データです。以前のBKC周辺の店舗・注文・配達履歴は変更しません。

配達詳細内の経路プレビューは模式図で、背景の実地図上の点線も直線です。道路に沿った距離と所要時間は、同意後に開くOpenStreetMap側で確認します。OpenStreetMapは外部サービスのため、インターネット接続と同サービスの提供状況に依存します。

## リアルタイム更新

ログイン後は同一サーバーの`/api/realtime`へWebSocketで接続し、注文や勤務状態が変わった通知を受けると、認証済みAPIから最新状態を再取得します。イベントには注文内容や位置情報を含めません。

- アクセストークンはURLへ付けず、WebSocketサブプロトコルで接続時だけ送ります。
- 切断時は間隔を広げながら自動再接続し、その間は10秒ごとの更新へ戻ります。
- 接続中も取りこぼし対策として60秒ごとに状態を確認します。
- 現在の配信先は同じNode.jsプロセスへ接続中の画面です。複数サーバー間の配信は将来Redisなどが必要です。

## スコアの仕組み

配達完了の基本点は100ポイントです。雨天は30ポイント、日本時間22:00以上または5:00未満は50ポイントを追加します。両方なら合計180ポイントです。

見込みスコアはオファー作成時に固定されます。その後に天候や時刻が変わっても、受諾済みの配達で獲得するポイントは変わりません。同じ完了操作を再送しても二重加点されません。

## PostgreSQL版を動かす

Docker Desktopを起動し、設定ファイルを作成します。

```powershell
Copy-Item .env.postgres.example .env.postgres
docker compose --env-file .env.postgres up --build -d --wait
```

ブラウザで <http://localhost:3106> を開きます。停止は次のコマンドです。

```powershell
docker compose --env-file .env.postgres down
```

`down`だけならDBボリュームは残ります。`down -v`はDBデータも削除するため、明確に初期化したい場合以外は実行しないでください。

SQLiteだけをDockerで動かす場合は、ルートをビルドコンテキストに指定します。

```powershell
docker build -f apps/server/Dockerfile -t deliveryflow-web .
docker run --rm -p 3000:3000 -v deliveryflow-data:/data deliveryflow-web
```

## テストとCI

```powershell
npm run check
npm test
```

テストは開発用DBを変更せず、毎回一時SQLite DBを作成します。配達状態、認証、冪等性、履歴、スコア、ランキング、位置情報、WebSocket認証と順序付き通知を確認します。

Pull RequestではGitHub Actionsが次を自動確認します。

- Node.js 24での依存関係再現
- SQLite Migration、構文チェック、全テスト
- PostgreSQLコンテナのビルド、Migration、APIスモークテスト

## 困ったとき

### 直線距離が表示されない

1. 最新の`main`をpullします。
2. `npm run db:migrate`と`npm run db:generate`を実行します。
3. アプリを再起動し、ブラウザを再読み込みします。
4. 勤務開始後に「現在地を更新する」を押します。
5. オファーを確認し、「配達詳細」の「現在地 → 店舗」を見ます。

「店舗 → 届け先」は現在地がなくても表示されます。Docker版はコード変更後に`--build`を付けて再作成してください。

### DB構造を変更した

SQLiteとPostgreSQLのSchema・Migrationを両方更新し、両方のPrisma Clientを検証します。DBファイルや生成済みClientはGitへコミットしません。

## 関連文書

- [アーキテクチャとディレクトリ構成](docs/architecture.md)
- [配達ワークフローと状態遷移](docs/workflow.md)
- [データモデルと保存方針](docs/data-model.md)
- [設計判断とその理由](docs/decisions.md)
- [機能一覧と実装状況](docs/features.md)
- [デモ手順](docs/demo.md)
- [性能確認と負荷試験](docs/performance.md)
- [API仕様](docs/openapi.yaml)
- [実装状況とロードマップ](docs/PROJECT_STATUS.md)
- [新しいチャットへの引き継ぎ](docs/HANDOFF.md)

