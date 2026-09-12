# DeliveryFlow Web

配達員へのオファー提示、受諾、荷物の受取、配達完了までを扱う学習用Webアプリです。
ハッカソンで学んだ状態遷移を、Windowsで動かせる構成としてゼロから再実装しています。

## 使用技術

- Node.js: APIとWebサーバー
- HTML / CSS / JavaScript: ブラウザ画面
- Prisma: Node.jsからデータベースを操作するためのORM
- SQLite: ローカル開発用データベース
- OpenAPI: APIの契約書
- GitHub Actions: push、Pull Request時の自動チェック

## 初回セットアップ

PowerShellでプロジェクトを開き、次を実行します。

```powershell
Copy-Item .env.example .env
npm ci
npm run db:migrate
npm run db:generate
npm start
```

ブラウザで <http://localhost:3000> を開きます。API仕様は <http://localhost:3000/docs> です。

## `.env` と環境変数

`.env` は、ソースコードに直接書きたくない「実行環境ごとに変わる設定」を置くローカル専用ファイルです。Gitの管理対象外なので、将来パスワードや接続先が入っても誤ってGitHubへ送らないようにできます。共有するのは値を含まない雛形の `.env.example` です。

```env
DATABASE_URL="file:./delivery.db" # SQLiteデータベースの接続先
PORT=3000                          # Webサーバーの待受ポート
OFFER_TTL_SECONDS=120              # オファーの有効期限（秒）
```

`npm start` は Node.js の `--env-file=.env` を使って、この設定を読み込んでからサーバーを起動します。`DATABASE_URL` が未設定、または `PORT` / `OFFER_TTL_SECONDS` が正の整数でない場合は、設定ミスとして起動を止めます。

ポートを変える例です。変更後は、表示されるURLのポート番号も同じ値にしてください。

```powershell
(Get-Content .env) -replace '^PORT=.*$', 'PORT=3100' | Set-Content .env
npm start
```

## よく使うコマンド

```powershell
npm start              # アプリを起動
npm run check          # JavaScriptの構文を確認
npm test               # APIと状態遷移を自動で確認
npm run db:migrate     # schemaの変更をMigrationとしてDBへ反映
npm run db:generate    # Prisma Clientを再生成
npm run db:studio      # Prisma StudioでDBを見る
```

## 自動テスト

`npm test` は開発用の `delivery.db` を使いません。テスト実行ごとに一時的なSQLiteデータベースを作り、Migrationを適用してからAPIを起動します。現在は次を確認しています。

- 配達員が稼働開始し、オファーを表示・受諾・受取・完了できること
- 完了した配達を本人の履歴と実績件数で確認できること
- 状態が `IDLE` → `OFFERED` → `BUSY` → `IDLE` と正しく変わること
- 同じ `Idempotency-Key` の再送が同じ結果を返すこと
- Bearerトークンなしでは配達員用APIを呼べないこと
- 配達員IDだけでは認証できず、推測困難なトークンが必要なこと
- PINで同じ配達員として再ログインできること
- 勤務中はログアウトできず、OFFLINEの場合だけログアウトできること

テスト用DBは終了時に自動で削除されます。Node.js 22の標準SQLite機能を使っているため、追加のテスト用パッケージは不要です。

## 配達履歴と実績

配達を完了すると、配達員画面の「配達実績」に完了件数、最終配達時刻、直近20件の履歴が表示されます。`GET /api/deliveries/history` はBearerトークンで認証した配達員本人の完了済みデータだけを返します。

## Dockerで起動する

Dockerは、Node.js・Prisma・アプリ本体をひとつの実行単位（コンテナ）にまとめる仕組みです。Node.jsを個別に入れていないPCでも、Docker Desktopがあれば同じ起動手順を再現できます。

Docker Desktopを起動した状態で、次を実行します。

```powershell
docker build -t deliveryflow-web .
docker run --rm -p 3000:3000 -v deliveryflow-data:/data deliveryflow-web
```

ブラウザで <http://localhost:3000> を開きます。最初のコマンドはアプリ用イメージを作り、二つ目はコンテナを起動します。`-p 3000:3000` はPCのポート3000とコンテナ内のポート3000をつなぎます。

`-v deliveryflow-data:/data` はSQLiteのデータをDockerの名前付きボリュームへ保存する指定です。コンテナを停止・削除しても配達データは残ります。開発データを最初からやり直す場合だけ、次のコマンドで削除できます。

```powershell
docker volume rm deliveryflow-data
```

コンテナ起動時に `prisma migrate deploy` がMigrationを適用します。これはDBの構造を、アプリが期待する最新の形にそろえる処理です。

## PostgreSQLとDocker Compose

SQLiteは1つのファイルを直接読むため、手軽なローカル開発や高速なテストに向いています。PostgreSQLは独立したDBサーバーとして動き、複数接続や同時更新を扱いやすいため、本番運用に向いています。

このプロジェクトでは、学習・自動テスト用のSQLite構成を残しつつ、Docker Composeでは次の2サービスを起動します。

- `db`: PostgreSQLサーバー
- `app`: DeliveryFlowのNode.jsサーバー

PostgreSQL用のローカル設定を作ります。

```powershell
Copy-Item .env.postgres.example .env.postgres
```

`.env.postgres` の `POSTGRES_PASSWORD` はローカル開発専用です。本番環境では、ソース管理されないSecret管理機能から渡します。

起動は次のコマンドです。

```powershell
docker compose --env-file .env.postgres up --build -d
docker compose --env-file .env.postgres ps
docker compose --env-file .env.postgres logs app
```

機能開発中はDocker Compose 2.22以降のWatchを使うと、長いコマンドを毎回入力せずに変更を自動反映できます。

```powershell
docker compose version
npm run dev:postgres
```

このPowerShellを開いたままにすると、`public/`と`docs/`は保存時に同期され、`server.js`は同期後にアプリが再起動します。依存関係、Prisma、Docker関連ファイルの変更時はイメージが自動で再ビルドされます。Watchを終了するときは `Ctrl + C` を押します。Watchは開発用であり、PCやDocker Desktop自体を自動起動する機能ではありません。

PostgreSQLのデータをPrisma Studioで確認する場合は、Watchを動かしたまま別のPowerShellで次を実行し、<http://localhost:5555> を開きます。StudioはWindows側のPrismaから、PC内だけに公開した `127.0.0.1:5433` 経由でPostgreSQLへ接続します。

```powershell
npm run studio:postgres
```

Prisma Studioを終了するときは、そのPowerShellで `Ctrl + C` を押します。画面からデータを直接変更・削除できるため、確認だけの場合は編集しないよう注意してください。

ローカルのPostgreSQL接続は同じPCまたはDockerネットワーク内に限られるため、`DATABASE_URL`で `sslmode=disable` を指定します。PostgreSQLのホスト側ポートは `.env.postgres` の `POSTGRES_HOST_PORT` で変更でき、未指定時は5433です。将来クラウド上のPostgreSQLへ接続するときは、配備先の指示に従ってTLSを有効にします。

ブラウザで <http://localhost:3106> を開きます。`db` のヘルスチェックが成功してから `app` が起動し、PostgreSQL用Migrationを自動適用します。

停止する場合は次を実行します。

```powershell
docker compose --env-file .env.postgres down
```

通常の `down` では `postgres-data` ボリュームを削除しないため、次回起動時にもデータが残ります。`down -v` はDBデータも削除するコマンドなので、データを初期化すると明確に決めた場合だけ使用します。

SQLiteとPostgreSQLはSQLの一部の書き方が異なるため、SchemaとMigrationを分けています。`DATABASE_PROVIDER=sqlite` では従来のSQLite版、`DATABASE_PROVIDER=postgresql` ではPostgreSQL版を選択します。

## 認証・セキュリティの基礎

`POST /api/drivers` は配達員名と6桁のログインPINを登録し、配達員情報と43文字のランダムなアクセストークンを返します。画面はこのトークンをブラウザのローカルストレージに保存し、以後は `Authorization: Bearer <トークン>` として送信します。以前のような連番の配達員IDだけでは認証できません。

DBにはトークンそのものを保存せず、SHA-256で変換したハッシュだけを保存します。PINも平文では保存せず、ランダムなソルトと計算負荷のある `scrypt` を使ったハッシュとして保存します。PINの総当たりを抑えるため、同じ接続元・配達員IDで5回失敗すると15分間ログインを拒否します。この回数はアプリ再起動でリセットされる学習用の簡易実装です。既存の配達員にはPINがないため、新方式を試す場合は画面から新しい配達員を登録してください。

画面の「この端末からログアウトする」は、ブラウザのトークンを消すだけでなく、DBの `accessTokenHash` も削除します。再び利用するときは、画面に表示される配達員IDとPINを `POST /api/login` へ送り、新しいトークンを発行します。勤務中の状態だけが残るのを防ぐため、ログアウトは `OFFLINE` の場合だけ許可します。`IDLE` または `OFFERED` では先に退勤し、`BUSY` では配達完了後に退勤します。

すべての応答には、画面の埋め込みや意図しないスクリプト実行を抑制するセキュリティヘッダーを追加しています。また、JSON本文は1MBまでに制限し、大きすぎる入力には `413 PAYLOAD_TOO_LARGE` を返します。これは学習用の基本対策であり、実サービスではHTTPS、短い有効期限、ログアウト時の失効、権限管理も追加します。

## ログ・監視・負荷試験

サーバーは各HTTPリクエストの時刻、リクエストID、メソッド、パス、状態コード、処理時間をJSON形式で標準出力へ記録します。認証ヘッダー、クエリ文字列、PIN、アクセストークンはログへ記録しません。

- `GET /healthz`: アプリとデータベースに接続できるかを確認します。成功時は `{"status":"ok","database":"connected"}` を返します。
- `GET /metrics`: 起動からのリクエスト数、5xxエラー数、平均応答時間、稼働秒数を返します。ローカル学習用の簡易メトリクスです。

起動中のアプリに対して、標準機能だけで負荷試験できます。既定ではローカルの `/healthz` に100件を同時10件で送るため、外部サイトには送信できません。

```powershell
npm run load-test
```

件数と同時実行数を変える例です。

```powershell
$env:LOAD_TEST_REQUESTS = 500
$env:LOAD_TEST_CONCURRENCY = 25
npm run load-test
Remove-Item Env:LOAD_TEST_REQUESTS, Env:LOAD_TEST_CONCURRENCY
```

## 最初に読むファイル

- `public/index.html`: 画面の構造
- `public/app.js`: ブラウザからAPIを呼ぶ処理
- `server.js`: API、状態遷移、冪等性の処理
- `prisma/schema.prisma`: データベースの設計図
- `docs/openapi.yaml`: APIの契約書

## GitHubでの開発手順

`.github/workflows/ci.yml` は、`main` へのpushとPull Requestで次を自動確認します。

- Node.js 24で依存関係を再現できること
- SQLiteのMigration、JavaScript構文、API自動テストが成功すること
- Docker ComposeでPostgreSQL版をビルド・起動できること
- 起動したPostgreSQL版で登録、認証、ログアウト、再ログインが成功すること

これはCI（継続的インテグレーション）です。失敗した変更を `main` へ混ぜにくくします。クラウドへの自動配備を行うCDは、配備先とSecret管理を決める第10段階で追加します。

作業ごとにブランチを作り、変更をコミットしてPull Requestで`main`へ統合します。

```powershell
git switch -c feature/機能名
# ファイルを変更
npm run check
git add .
git commit -m "実装内容を短く書く"
git push -u origin feature/機能名
```

`.env`、SQLiteの実データ、`node_modules`、生成済みPrisma ClientはGitHubへ送信しません。
