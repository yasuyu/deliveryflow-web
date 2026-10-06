# ローカル利用のバックアップとスマートフォン確認

普段使うPostgreSQL版を対象にします。SQLiteのアカウントや履歴は別管理です。コマンドはリポジトリのフォルダーで実行してください。

## バックアップする

Docker DesktopとPostgreSQL版のDBを起動した状態で実行します。アプリを停止する必要はありません。

```powershell
npm run backup:postgres
```

`data/backups/`へ日時とランダム文字列付きの`.dump`と`.dump.sha256`を保存します。アカウント・配達履歴・ポイント・再送応答・AIの保存結果・Migration・ID採番を含むDB全体が対象です。完成前のファイルは`.partial`で、復元に使用しません。既存のバックアップを上書きしたり、自動で古いものを削除したりしません。

コンテナ内の[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)でカスタム形式の一貫したスナップショットを取得し、Node.jsがバイナリーのまま保存します。PowerShellの文字列リダイレクトは使いません。PC側にPostgreSQLのツールを追加する必要はありません。

バックアップはGit管理外ですが、認証用ハッシュなどを含む個人用データです。第三者へ共有せず、必要に応じて`.dump`と`.dump.sha256`の両方を自分の外部ディスクなどへコピーしてください。`.env.postgres`やOpenAI APIキー、PostgreSQLのロール定義は含まれないため、設定は別途、非公開で保管します。

## 新しいDBへ復元する

直近のバックアップを選び、復元します。

```powershell
$backupFile = Get-ChildItem -LiteralPath .\data\backups -Filter '*.dump' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $backupFile) { throw 'バックアップがありません。' }
npm run restore:postgres -- --file $backupFile.FullName
```

チェックサムとアーカイブ形式を確認したあと、`deliveryflow_restore_`で始まる新しいDBへ[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)で復元します。復元先名・配達員数・完了配達数・加点履歴数を表示します。普段使うDBと同じ名前は拒否し、既に存在するDBも上書きしません。`DROP`、`--clean`、ボリューム削除を使いません。DB作成後に失敗した場合も、復元用DBを自動削除しません。

名前を指定したい場合は、英小文字・数字・`_`で、63文字以内の新しい名前を使います。

```powershell
npm run restore:postgres -- --file $backupFile.FullName --database deliveryflow_restore_check_01
```

この操作だけでは、稼働中のアプリの接続先は変わりません。まず別DBでデータを確かめられます。

### 復元したDBをアプリの接続先にする場合

必要な場合だけ、監視を`Ctrl+C`で止め、`.env.postgres`の`POSTGRES_DB`をコマンドが表示した復元先名へ変更します。`POSTGRES_USER`、`POSTGRES_PASSWORD`、既存の`COMPOSE_PROJECT_NAME`は維持します。

```powershell
docker compose --env-file .env.postgres start db
docker compose --env-file .env.postgres up --build --no-deps --force-recreate -d --wait app
```

アプリだけを再作成し、DBコンテナ・ボリュームは保持します。復元した配達員でログインして履歴を確認してください。以前のDBも保持しているので、接続先を元のDB名へ戻して同じ手順を実行すると、元の環境へ戻せます。

### バックアップと復元をまとめて検証する

配達操作をしていないタイミングで実行します。

```powershell
npm run test:backup:postgres
```

新しいバックアップと復元用DBを作り、全9テーブルの件数・内容の指紋とID採番が一致すること、同名DBへの再復元が拒否されて内容が保持されることを確認します。氏名・PIN・トークン・位置などの値は出力しません。検証中に元DBが更新された場合は、バックアップを保持して検証を中止します。テスト後もバックアップと復元用DBは残します。検証用のファイルは`data/backup-verification/`へ保存し、別の検証環境のデータが普段の`data/backups/`へ混ざらないようにします。

別の検証環境では、`--env-file`でComposeの設定ファイルを指定できます。CIは専用のPostgreSQL環境だけで実行します。

```powershell
npm run test:backup:postgres -- --env-file .env.postgres.example
```

## スマートフォンで中断・再開を確認する

画面へ戻ったときに表示位置を調整し、WebSocketを接続し直して最新の配達状態を確認します。通信が戻れば、保留中の操作を同じ冪等キーで再送します。表示中の設定・実績ビューとシートの段階は保持します。端末位置を自動取得したり、バックグラウンドで追跡したりしません。

次の確認は学習用の配達で、止まった状態で行ってください。

1. オファーを受諾し、画面をロックしてから解除する。上部の勤務状態と受取ボタンを確認する。
2. 設定を開き、別アプリへ切り替えてから戻る。設定画面とシートの段階が維持されていることを確認する。
3. 荷物受取後に通信を切り、「配達完了しました」を押す。端末へ保存された案内を確認し、通信を戻す。送信待ちが消えて、履歴と加点が1件だけ増えることを確認する。
4. オファー表示中に30秒以上画面をロックしてから戻る。古いオファーを受諾できず、最新の状態と案内が表示されることを確認する。
5. 退勤後、勤務サマリー内の「無料の振り返り」を読む。APIキー未設定でも実績に合う定型コメントが表示されることを確認する。

Playwrightでは中断・復帰イベントを模擬し、実際のWebSocket・APIと通信切断を使って検証します。iOSの実際の画面ロックやOSによる終了は自動テストだけでは確認できないため、実機で確認します。PCの停止・スリープ中はサーバーへ接続できません。ページ自体のオフライン起動は対象外です。
