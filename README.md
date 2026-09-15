# DeliveryFlow Web

DeliveryFlowは、配達員の「勤務開始 → オファー確認 → 受諾 → 荷物受取 → 配達完了」をブラウザで試せる学習用Webアプリです。

すべて自分のPC内で無料で動かせます。普段の開発にはSQLite、本番に近い確認にはDocker ComposeとPostgreSQLを使います。

## できること

- 配達員の登録、6桁PINでのログイン、ログアウト
- 正しい状態遷移に沿った配達操作
- 配達履歴の検索と絞り込み
- 基本点、雨天・深夜ボーナス、称号、月間・14日間・全期間ランキング
- 明示的に許可した現在地から店舗までの直線距離表示
- SQLiteとPostgreSQLの両方で同じAPIを実行
- OpenAPI仕様、テスト、CIによる動作確認

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

## 画面で試す順番

1. 名前と6桁PINを入力して配達員を登録します。
2. 「稼働を開始する」を押します。
3. 必要なら「現在地を更新する」を押し、ブラウザの位置情報を許可します。
4. 「オファーを確認する」を押します。
5. 配達詳細で、見込みスコアと直線距離を確認します。
6. 受諾、荷物受取、配達完了の順に進めます。
7. 業務が終わったら退勤します。保存中の現在地はこの時点で削除されます。

雨天ボーナスは画面の「天候シミュレーター」で確認できます。外部の気象APIには接続しません。

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
│  │  │     ├─ location/            位置の鮮度と距離計算
│  │  │     └─ score/               スコアとボーナス計算
│  │  └─ test/                      API・機能テスト
│  └─ web/
│     └─ public/                    HTML、CSS、ブラウザJS
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
│  └─ PROJECT_STATUS.md             実装状況と次の候補
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
| `npm run load-test` | ローカルのヘルスチェックへ負荷試験 |

## 設定ファイル

`.env`はPCごとのローカル設定です。Gitには保存されません。

```env
DATABASE_URL="file:./delivery.db"
PORT=3000
OFFER_TTL_SECONDS=120
# SCORE_BONUS_SIMULATED_NOW="2026-09-14T22:00:00+09:00"
```

- `DATABASE_URL`: SQLiteファイルの場所。Prisma Schemaからの相対位置です。
- `PORT`: アプリのポート番号。
- `OFFER_TTL_SECONDS`: オファーが期限切れになるまでの秒数。
- `SCORE_BONUS_SIMULATED_NOW`: 深夜ボーナスを日中に試す場合だけ指定します。

## 現在地とプライバシー

位置情報は「現在地を更新する」を押したときだけブラウザへ要求します。自動追跡やバックグラウンド取得は行いません。

- 保存できるのは勤務中だけです。
- 最終更新から5分を超えると、店舗までの計算には使いません。
- 退勤すると緯度・経度・精度・更新時刻をDBから削除します。
- API画面には正確な緯度・経度を返しません。
- 距離は外部地図へ送らず、サーバー内で直線距離として計算します。
- 店舗と届け先の座標はBKC周辺の学習用仮データです。

道路に沿った距離や所要時間ではない点に注意してください。

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

テストは開発用DBを変更せず、毎回一時SQLite DBを作成します。配達状態、認証、冪等性、履歴、スコア、ランキング、位置情報の検証と退勤時削除を確認します。

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
