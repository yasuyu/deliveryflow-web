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

## よく使うコマンド

```powershell
npm start              # アプリを起動
npm run check          # JavaScriptの構文を確認
npm run db:migrate     # schemaの変更をMigrationとしてDBへ反映
npm run db:generate    # Prisma Clientを再生成
npm run db:studio      # Prisma StudioでDBを見る
```

## 最初に読むファイル

- `public/index.html`: 画面の構造
- `public/app.js`: ブラウザからAPIを呼ぶ処理
- `server.js`: API、状態遷移、冪等性の処理
- `prisma/schema.prisma`: データベースの設計図
- `docs/openapi.yaml`: APIの契約書

## GitHubでの開発手順

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
