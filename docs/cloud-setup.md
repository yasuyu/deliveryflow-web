# NeonとRenderでスマートフォンから使う

確認日: 2026-10-09。Renderの初回デプロイ画面で、`main`のコミット`4ecbe63`が「Deploy succeeded / Live」になったことを確認しました。公開URLで登録・ログイン画面、DB接続、DB休止用ヘルスチェック、PWA Manifestを確認しました。アクセス直後のRenderの復帰待ち画面からアプリ表示への遷移も確認しました。許可を得た検証用配達員1人で、配達1件、受付30秒、標高データ、WebSocket接続、履歴・スコア、退勤サマリー・無料の振り返り、再送時の二重加点防止を確認しました。検証用の配達員・履歴はクラウドDBへ保持しています。無通信で待機後、Neonのコンピュートが`idle`になり、`/readyz`のHTTP 200と`database: connected`で復帰、コンピュートが`active`に戻ることを確認しました。復帰後も配達1件・加点1件・150ポイントが保持されていました。移行後、利用者からスマートフォン実機で以前のID・PINによるログインができたとの確認を受けました。PC停止時の利用と、新しいURLからのホーム画面追加は確認待ちです。

PCを停止している間も使うには、Node.jsアプリをRenderのFree Web Service、DBをNeonのFreeプランに配置します。ローカルのDocker Composeは普段の開発・検証用として残します。

## 1. Neonに新しいDBを作る

1. [Neon Console](https://console.neon.tech)で登録・ログインします。
2. Freeプランで、DeliveryFlow専用の新しいプロジェクトを作成します。既存の別アプリのDBは使いません。
3. PostgreSQLはローカルと同じ17、またはPrisma 6で動作確認した18を選びます。この利用環境のNeonは18で、ローカルの17との列・主キー・外部キー・一意制約の一致を確認しています。Render側も近いリージョンを選ぶため、両サービスで選択できる近い地域を確認します。
4. 接続画面のConnection poolingをオフにして、直接接続のURLを取得します。パスワードを含むため、チャット・Git・スクリーンショットへ載せません。
5. URLの既存パラメーターを保ち、`sslmode=require`と`connect_timeout=15`があることを確認します。既に`?`があるURLへパラメーターを追加する際は`&`でつなぎます。

このアプリはPrisma 6のPostgreSQLクライアントを使います。初回は単一のRenderアプリから直接接続し、アプリと起動時のMigrationで同じ`DATABASE_URL`を使います。NeonのPrisma 7向けの例をそのまま適用して、依存関係やSchemaを変更する必要はありません。

## 2. Renderにアプリを設定する

### Neon CLIをこの作業フォルダーへ設定する場合

このプロジェクトには、Postgresのみを利用する最小の`neon.ts`と、公式の`@neon/config`・`@neon/env`パッケージを追加しています。CLIのログインは本人がブラウザーで承認します。

```powershell
npm i -g neon@latest
neon login
neon skills -y
neon mcp -y --agent codex --project-id <project-id>
neon link --project-id <project-id> --branch production -y --no-env-pull
neon config plan --branch production
neon deploy --branch production --no-env-pull
neon env pull --branch production --service postgres --file .env.neon.local
```

`<project-id>`にはNeon Consoleで確認した自分のプロジェクトIDを指定します。MCPはCodexだけに設定し、対象をそのプロジェクトへ限定します。`.neon`、`.env.neon.local`、インストールしたスキルはGit管理外です。MCPの認証情報はPC側のCodex設定に保存し、リポジトリへ入れません。

通常の`link`や`deploy`は既存の`.env`へ接続情報を取得するため、ここでは`--no-env-pull`でその動作を止め、最後に専用ファイルへ取得します。SQLiteの`.env`とローカルPostgreSQLの`.env.postgres`は維持します。`.env.neon.local`の`DATABASE_URL_UNPOOLED`が、Renderへ設定する直接接続URLです。

NeonでDBのパスワードを再設定しても、PC側の環境ファイルとRenderの環境変数は自動で更新されません。上記の`neon env pull`を再実行し、Renderの`DATABASE_URL`も新しい直接接続URLへ更新してください。接続URLやパスワードはチャットへ貼り付けません。

空の`defineConfig({})`を適用してもDeliveryFlowのWeb画面やNode.jsサーバーは公開されません。アプリのDBテーブルを作るPrisma Migrationとも別の操作です。続けて、以下のRender設定を行います。

### RenderのWeb Service

[Render Dashboard](https://dashboard.render.com)からNew → Web Serviceを選び、GitHubの`yasuyu/deliveryflow-web`を接続します。

| 項目 | 設定 |
| --- | --- |
| Branch | `main` |
| Language / Runtime | `Docker` |
| Root Directory | 空欄（リポジトリのルート） |
| Dockerfile Path | `apps/server/Dockerfile` |
| Docker Build Context Directory | `.`（リポジトリのルート） |
| Docker Command | 空欄（既存のCMDを使用） |
| Instance Type | `Free` |
| Health Check Path | `/healthz` |
| Auto-Deploy | 初回確認中はオフ。更新は確認後に手動で実施 |

Auto-Deployの表は推奨設定です。この利用環境の実際の選択状態は未確認です。更新時はRenderの設定を確認してください。

環境変数はRenderのサーバー設定へ入力します。

| キー | 値 |
| --- | --- |
| `DATABASE_PROVIDER` | `postgresql` |
| `DATABASE_URL` | Neonの直接接続URL。秘密情報として管理 |
| `DATABASE_IDLE_MODE` | `true` |
| `NODE_ENV` | `production` |
| `OFFER_TTL_SECONDS` | `30` |
| `OFFER_CANDIDATE_LIMIT` | `3` |

`PORT`はRenderから渡される値を使います。ローカル用の`APP_PORT`、`POSTGRES_HOST_PORT`、`.env.postgres`ファイルはRenderへ持ち込みません。既存のDockerイメージは起動時に環境変数を使ってPostgreSQLのMigrationを適用し、Node.jsサーバーを起動します。`npm start`はローカルの`.env`を読むため、Renderの起動コマンドには設定しません。

初回は`OPENAI_API_KEY`を設定せず、追加課金のない定型振り返りを使用します。AIを使う場合は、公開後に必要性を確認してRenderのサーバー環境変数へ別途設定します。

## 3. 公開する前に確認する

- Instance TypeがFreeで、有料のDB・ディスク・追加サービスを作成していないこと。
- `DATABASE_URL`の接続先が、新しく作ったDeliveryFlow用のNeon DBであること。
- URLを知る人が登録・ログインできる公開Webアプリになること。個人の実データは持ち込まず、デモ位置で確認すること。
- PC側のアカウント・配達履歴は自動で移行されないこと。まずクラウド側にテスト用の配達員を新規登録すること。

PC側の履歴を移す場合は、別途バックアップ・移行先・移す範囲を確認してから実施します。この手順では移行・上書き・削除を行いません。

## PC版のデータを引き継ぐ

2026-10-09に、この利用環境では明示依頼を受けてローカルPostgreSQLのアカウント・完了した配達履歴・スコアをNeonへ移行しました。ログイン可能な配達員のIDとPINは維持し、クラウド側のデモ配達員は重複させずPC側の実績日時に合わせました。累計・14日間・月間のポイントは引き継ぎ、既存のクラウド検証用記録も保持しています。クラウド固有の配達員もランキングに含まれるため、順位番号は追加分だけ変わる場合があります。

移行前に両DBのバックアップを保存し、別のローカルDBへの復元、途中失敗のロールバック、移行後のデータ照合と再実行時の重複防止を検証しました。元のPC版DB・SQLite・環境設定は保持しています。バックアップと移行用データは認証情報を含むため、Gitやチャットへ載せません。

移行後の公開アプリの認証済みAPIでも、履歴20件＋次の1件、スコア、3期間ランキングを確認しました。検証用の一時認証は解除し、確認前後の履歴・ポイント・ID採番の一致と、以前のPINハッシュの保持を確認しています。利用者からスマートフォン実機で以前のID・PINによるログインができたとの確認を受けました。PC停止時の利用とホーム画面追加は別途確認します。

クラウド版では以前のID・PINでログインし、退勤状態から再開できます。以前のセッションや現在地、進行中の勤務は持ち込みません。ログイン不可の古い検証用未完了配達はPC側に残しています。

この移行は一度のコピーです。以後、PC版とクラウド版の新しい履歴は自動同期されません。継続利用にはRenderの公開URLを使い、古いPC版のホーム画面アイコンは新しい公開URLから追加し直してください。別の環境でこの手順書を使って公開しても、データ移行は自動実行されません。

## 4. 公開後に確認する

1. RenderのHTTPS URLを開き、`/healthz`が`{"status":"ok","database":"not_checked"}`を返すことを確認します。必要なときだけ`/readyz`でDB接続を確認します。
2. 新しい配達員で登録・ログインし、勤務開始 → 30秒オファー → 受諾 → 荷物受取 → 配達完了 → 退勤まで操作します。
3. スコア・履歴の保存、勤務サマリー・無料の振り返り、スマートフォン上部の状態表示、標高グラフ、退勤確認を確認します。追加読込は履歴が21件以上ある場合に確認します。
4. スマートフォンでホーム画面へ追加し、PCを停止しても同じHTTPS URLで利用できることを確認します。
5. アプリを開いた全端末を閉じ、DB確認画面や定期監視も止めます。NeonのDBコンピュートが休止することを確認し、アプリを再度開いて保存済みの履歴と接続復帰を確認します。
6. 15分以上アクセスしなかった後のRenderからの復帰も確認します。最初の表示には約1分かかることがあります。

アプリを開いたままの場合は表示更新がDBを使います。定期監視に`/readyz`を使ったり、外部サービスでURLを繰り返し開いたりすると休止を妨げます。`DATABASE_IDLE_MODE=true`での期限切れ位置の物理削除は、次の認証済み利用まで遅れます。詳しくはREADMEのDB休止設定を参照してください。

## 無料運用の確認

Freeでも利用量の上限があります。Render・Neonの利用量画面を確認し、有料プランへの切替は必要になってから判断します。Renderは支払方法が登録されている場合、転送量やビルド枠の超過で追加料金が生じ得るため、サービスのFree指定だけで無条件に無料になるわけではありません。

無料枠の最新条件と設定方法は公式資料を確認してください。

- [Renderの無料サービスと制限](https://render.com/docs/free)
- [RenderのDocker設定](https://render.com/docs/docker)
- [Neonのプラン](https://neon.com/pricing)
- [NeonのPrisma接続・復帰時のタイムアウト](https://neon.com/docs/guides/prisma)
