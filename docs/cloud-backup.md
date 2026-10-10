# クラウド版のバックアップと復元確認

クラウド版を使い続けると、新しい配達履歴・ポイントはNeonに増えます。PC版とは自動同期しません。`npm run backup:postgres`はPC版の保存用です。クラウド版には以下の専用コマンドを使います。

## 必要なもの

- Node.js 22以上、Docker DesktopまたはDocker Engine。
- このリポジトリのGit管理外の`.env.neon.local`。`DATABASE_URL_UNPOOLED`へNeonの直接接続URLを保存します。既に取得済みならそのファイルを使います。取得方法は[クラウド利用手順](cloud-setup.md#neon-cliをこの作業フォルダーへ設定する場合)を参照してください。

直接接続は`DATABASE_URL_UNPOOLED`、`DIRECT_URL`、`DATABASE_URL`の順に選びます。pooler接続とSSL無効の設定は拒否します。接続先・パスワードをコマンド引数へ書く必要はありません。既存の`.env`・`.env.postgres`・Renderの設定は変更しません。

`postgres:18-alpine`のツールをDockerで使うため、PCへPostgreSQLを追加インストールする必要はありません。対応する保存元はPostgreSQL 17・18です。18から取得するバックアップを17へ復元せず、専用の18の環境で確認します。初回はDockerイメージの取得に時間がかかります。

## 保存する

リポジトリのルートで実行します。

```powershell
npm run backup:cloud
```

`data/cloud-backups/`へ日時付きの次の2ファイルを追加保存します。

- `deliveryflow_cloud_日時_識別子.dump`: PostgreSQLのカスタム形式。
- 同名の`.dump.sha256`: 破損を検出するチェックサム。

アカウント、PIN・トークンのハッシュ、配達履歴、ランキング用のポイント、再送応答、AIの保存結果、Migration、ID採番を含むDB全体を保存します。保存元への接続は読み取り専用です。[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)が一貫したスナップショットを作るので、通常の保存は配達操作と並行できます。保存開始後の新しい実績は次回のバックアップ対象です。

処理途中のファイルは`.partial`のまま残り、完成扱いにしません。古いバックアップは上書き・自動削除しません。成功の表示と`.sha256`がそろったことを確認します。

別の専用環境ファイルを使う場合:

```powershell
npm run backup:cloud -- --env-file .env.neon.local
```

## 保存した内容を復元して照合する

配達操作を止め、開いているアプリを閉じて実行します。

```powershell
npm run test:backup:cloud
```

新しいクラウドバックアップを作り、`compose.cloud-backup.yaml`の専用PostgreSQL 18コンテナへ復元します。通常のPC版コンテナ・DB・ボリュームとは別です。専用コンテナはホストへのポートを公開せず、アプリを起動しません。

成功時は次を照合しています。

- 全9テーブルの件数・内容の指紋。認証情報、完了履歴、ポイントを含みます。
- 全シーケンスの現在値と使用済み状態。次のIDが正しく発行されることを確認します。
- 検証前後のクラウドDBが一致し、検証中に実績が変わっていないこと。
- 同じ復元先DBへの再復元が拒否され、既存データが保持されること。

照合後にだけ、同名の`.dump.verification.json`を追加します。日時、アーカイブのチェックサム、復元DB名、件数、照合用の指紋を記録し、氏名・PIN・トークン・接続URLを出力しません。元DBが検証中に更新された場合は、検証を成功扱いにせず、バックアップと復元DBを保持します。操作を止めて再度検証してください。

## 指定したバックアップを復元する

表示されたファイル名を`--file`へ指定します。

```powershell
npm run restore:cloud -- --file data/cloud-backups/deliveryflow_cloud_日時_識別子.dump
```

毎回`deliveryflow_restore_cloud_`で始まる新しいローカルDBへ復元します。チェックサムとアーカイブを確認してからDBを作成し、単一トランザクションで復元します。既存DBへの上書き、DROP、`--clean`は使いません。復元が失敗した場合も新しいDBを自動削除しません。保存元への接続情報は不要です。

復元先名を決める場合も、新しい専用名だけを指定できます。

```powershell
npm run restore:cloud -- --file data/cloud-backups/deliveryflow_cloud_日時_識別子.dump --database deliveryflow_restore_cloud_check_01
```

これはローカルでの復元確認です。稼働中のNeonへの書き戻しや、Renderの接続先の変更は行いません。実際にクラウドへ戻す必要が生じたら、新しい復旧先を準備して内容を確認した後に接続先を切り替えます。

## 保存頻度と保管

利用した日の終了後と、データ移行・大きな更新の前に`npm run backup:cloud`を実行します。定期的に`npm run test:backup:cloud`でも復元を確認してください。これは手動実行で、自動スケジュールは設定しません。PC停止中はこのコマンドによる保存は行われません。

バックアップは機密データを含みます。`data/`全体はGit管理外、Dockerビルド対象外です。PC故障にも備える場合は、`.dump`・`.sha256`・検証記録を一緒に、本人だけがアクセスできる別の保存先にもコピーしてください。この機能では外部ストレージへ自動送信しません。

復元用DBと専用ボリュームは検証後も保持します。使わないときは、専用コンテナだけを停止できます。

```powershell
npm run stop:backup:cloud
```

次の復元・照合コマンドで自動起動します。ボリューム削除やデータの初期化は行いません。

## 開発・CIでの検証

```powershell
npm run test:backup:cloud:fixture
```

新しいローカル検証用DBに架空の日本語データを作り、同じ保存・復元・照合処理を確認します。Neonの接続情報は不要で、実際のクラウドへ接続しません。アーカイブは通常のバックアップと混ざらない`data/cloud-backup-verification/`へ保存します。CIもこの方法を使います。

接続方法・ツールの前提は[Neon公式のバックアップ手順](https://neon.com/docs/manage/backup-pg-dump)を参照してください。
