# アーキテクチャとディレクトリ構成

## 目的

DeliveryFlowは、現在は1台のPCで動かす学習用アプリです。構成は次の3点を優先しています。

1. Web画面、API、DB、文書の置き場所が見ただけで分かること
2. 機能を追加するときに、関係するファイルを同じ場所へまとめられること
3. SQLite版とPostgreSQL版の動作を同じコードで保てること

参考資料のような大規模構成をそのまま複製せず、現時点で実装されている責務だけを配置しています。Redis、WebSocket、道路グラフ、専用シミュレーターなどは、実装すると決まった段階で追加します。

## 全体構成

```text
deliveryflow-web/
├─ README.md
├─ AGENTS.md
├─ package.json
├─ package-lock.json
├─ prisma.config.ts
├─ compose.yaml
├─ apps/
│  ├─ server/
│  │  ├─ Dockerfile
│  │  ├─ docker-entrypoint.sh
│  │  ├─ src/
│  │  │  ├─ main.js                    HTTP APIと配達フロー
│  │  │  └─ modules/
│  │  │     ├─ location/
│  │  │     │  └─ location.js          距離・鮮度・入力検証
│  │  │     └─ score/
│  │  │        └─ score-bonuses.js     加点条件と内訳
│  │  └─ test/
│  │     ├─ api.test.js
│  │     ├─ location.test.js
│  │     └─ score-bonuses.test.js
│  └─ web/
│     └─ public/
│        ├─ index.html
│        ├─ app.js
│        ├─ style.css
│        └─ docs.html
├─ prisma/
│  ├─ schema.prisma                    SQLite用
│  ├─ schema.postgresql.prisma         PostgreSQL用
│  ├─ migrations/                      SQLite Migration
│  └─ migrations-postgresql/           PostgreSQL Migration
├─ generated/                           Prisma生成物（Git管理外）
├─ docs/
│  ├─ architecture.md
│  ├─ workflow.md
│  ├─ data-model.md
│  ├─ decisions.md
│  ├─ features.md
│  ├─ demo.md
│  ├─ performance.md
│  ├─ openapi.yaml
│  └─ PROJECT_STATUS.md
└─ scripts/
   ├─ load.js
   ├─ postgresql-smoke.js
   └─ studio-postgresql.js
```

## 各領域の責務

### `apps/web`

ブラウザに配信する画面です。APIを呼び出しますが、DBへ直接アクセスしません。

- `index.html`: 画面構造
- `app.js`: ボタン操作、API通信、画面更新
- `style.css`: 見た目とレスポンシブ表示
- `docs.html`: OpenAPI仕様の閲覧画面

### `apps/server/src/main.js`

Node.jsの起動点です。HTTPルーティング、Bearer認証、配達状態遷移、Prismaを使った保存を担当します。

現在は依存パッケージを少なく保つため1ファイルですが、新しい機能ロジックは`modules`へ分離します。HTTP処理そのものまで増えて見通しが悪くなった時点で、driver、offer、assignmentなどのAPIモジュールへ段階的に分割します。

### `apps/server/src/modules`

HTTPやDBに依存しない、単体テスト可能な機能ロジックを置きます。

- `location`: Haversine式による直線距離、5分の鮮度判定、座標検証
- `score`: 基本点、雨天・深夜ボーナス、保存済み内訳の解析

新しい機能は、たとえば`modules/route`や`modules/matching`のように責務名で追加します。名前だけの空フォルダは作りません。

### `prisma`

DBの設計と変更履歴です。SQLiteとPostgreSQLではSQL方言が異なるため、SchemaとMigrationを分けています。機能上のモデルと制約は両者で一致させます。

`prisma.config.ts`が`DATABASE_PROVIDER`を読み、使用するSchemaとMigrationを切り替えます。生成済みPrisma Clientは`generated`へ出力し、Gitでは管理しません。既存のローカルSQLiteファイルとの互換性を保つため、この領域はルートに残しています。

### `apps/server/test`

- `api.test.js`: 一時SQLite DBと実際のHTTPサーバーを使う結合テスト
- `location.test.js`: 距離・鮮度・入力範囲の単体テスト
- `score-bonuses.test.js`: 加点ルールと時間境界の単体テスト

### `docs`

- `openapi.yaml`: APIが受け取る値と返す値の契約
- `PROJECT_STATUS.md`: 完了済み機能、未実装部分、次の候補
- `architecture.md`: この文書。配置と責務の判断基準
- `workflow.md`: Driver・Order・Offer・Assignmentの状態遷移と操作条件
- `data-model.md`: Prismaモデルの関係、制約、データのライフサイクル
- `decisions.md`: 採用した設計、その背景、利点と制約
- `features.md`: 機能ID、実装状況、実装や確認場所
- `demo.md`: 主要機能を画面で再現する手順と確認項目
- `performance.md`: 簡易負荷試験、メトリクス、測定時の注意点

### `scripts`

アプリ本体とは独立して外側から実行する開発ツールです。サーバーの内部関数を直接呼ばず、実際のAPIまたはPrisma CLIを利用します。

## 処理の流れ

```text
ブラウザ
  ↓ HTTP + Bearer token
apps/server/src/main.js
  ├─ modules/location  距離・位置検証
  ├─ modules/score     スコア計算
  ↓ Prisma Client
SQLite または PostgreSQL
```

Web画面はDB構造を知りません。機能モジュールはHTTP応答の書き方を知りません。この境界を保つことで、画面やDBを変更したときの影響範囲を小さくします。

## 変更するときの目安

| 変更したい内容 | 主に触る場所 |
|---|---|
| 画面表示やボタン | `apps/web/public` |
| APIや状態遷移 | `apps/server/src/main.js` |
| 距離・位置ルール | `apps/server/src/modules/location` |
| スコア・ボーナス | `apps/server/src/modules/score` |
| DBモデル | `prisma`の両Schema・両Migration |
| APIの公開契約 | `docs/openapi.yaml` |
| 実装状況・次の予定 | `docs/PROJECT_STATUS.md` |
| 機能単位の実装状況 | `docs/features.md` |
| デモの進め方 | `docs/demo.md` |
| 負荷試験と性能確認 | `docs/performance.md` |
| 起動・使い方 | `README.md` |

変更後は最低限`npm run check`と`npm test`を実行します。DB変更時はSQLiteとPostgreSQLの両方を検証します。

## 今後の分割基準

`main.js`を細かく分けること自体を目的にはしません。次のいずれかが起きたときに、機能単位のAPIモジュール化を検討します。

- 1つの機能を変更するために無関係な処理まで読み解く必要がある
- 同じ検証やDB操作が複数箇所へ重複する
- 複数人が同じファイルを頻繁に編集して競合する
- 単体テストしたい処理がHTTPサーバーから切り離せない

その際も`driver`、`offer`、`assignment`、`location`、`score`など、業務上の責務で分割します。
