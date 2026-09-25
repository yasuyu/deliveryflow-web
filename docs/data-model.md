# データモデル

DeliveryFlowの永続データはPrismaで定義します。SQLite用は`prisma/schema.prisma`、PostgreSQL用は`prisma/schema.postgresql.prisma`です。両者はDB方言以外のモデルと制約を一致させます。

## 関係図

```text
Store 1 ───── * Order
                  ├──── * Offer * ───── 1 Driver
                  └──── 0..1 Assignment * ───── 1 Driver
                                     └──── 0..1 ScoreEvent

Driver 1 ─··· * IdempotencyKey（driverIdによる論理参照。DB外部キーは未定義）

ScoreRule（加点ルールのマスター）
```

読み方の例:

- 1つのStoreは複数のOrderを持ちます。
- 1つのOrderには複数候補のOfferを作れます。
- 1つのOrderに確定できるAssignmentは最大1件です。
- 1つのAssignmentに作成できるScoreEventは最大1件です。

## モデル一覧

### Driver

配達員の認証情報、勤務状態、累計スコア、勤務中の最新位置を保持します。

| 主なフィールド | 用途 |
|---|---|
| `id`, `name` | 配達員の識別と表示名 |
| `accessTokenHash` | BearerトークンのSHA-256ハッシュ。トークン本体は保存しない |
| `pinHash` | ソルト付きscryptで変換したPIN。平文は保存しない |
| `status` | `OFFLINE`、`IDLE`、`OFFERED`、`BUSY` |
| `shiftStartedAt` | 現在の勤務開始時刻 |
| `score` | 全期間の累計スコア |
| `latitude`, `longitude` | 勤務中のデモ位置、または約100m単位に丸めた最新端末座標 |
| `locationAccuracyMeters` | 丸め幅を含めた推定精度。デモ位置では`null` |
| `locationUpdatedAt` | サーバーが位置を保存した時刻 |
| `locationSource` | `DEMO`または`DEVICE` |

位置関連の5項目はすべて任意です。退勤時または最終更新から12時間経過後に`null`へ戻します。

### Store

受取店舗の名前、住所、学習用座標を保持します。1店舗から複数のOrderを作れます。

### Order

配送そのものを表します。Storeを1件参照し、受取先・届け先・届け先座標・配達料金・配送状態を保持します。`deliveryFeeYen`は画面に表示する円額で、現在のテスト注文では500円です。

`status`の遷移は`CREATED → OFFERING → ASSIGNED → PICKED_UP → DELIVERED`です。状態の詳しい条件は[workflow.md](workflow.md)を参照してください。

### Offer

「どのOrderをどのDriverへ提示したか」を表します。

| 主なフィールド | 用途 |
|---|---|
| `orderId`, `driverId` | 対象注文と候補配達員 |
| `status` | 返答待ち、受諾、辞退、期限切れ、取り下げ |
| `expiresAt` | 受諾可能期限 |
| `estimatedPoints` | オファー作成時に固定した見込み点 |
| `scoreBreakdown` | 加点コード・表示名・点数のJSONスナップショット |
| `distanceToPickupMeters` | 候補選定時に保存した店舗までの直線距離（メートル） |

`orderId + driverId`は一意です。1つのOrderに複数の候補Offerを作り、最初に受諾されたOffer以外は`WITHDRAWN`になります。

### Assignment

受諾後の担当配達です。

- `orderId`が一意なので、同じOrderを2人へ確定できません。
- `acceptedAt`、`pickedUpAt`、`deliveredAt`で進行時刻を記録します。
- Offerの見込み点と内訳をコピーし、完了まで固定します。

### ScoreRule

加点ルールのマスターです。

| コード | 初期点 | 条件 |
|---|---:|---|
| `DELIVERY_COMPLETED` | 100 | 配達完了時の基本点 |
| `WEATHER_RAIN` | 30 | オファー作成時の天候が雨 |
| `TIME_LATE_NIGHT` | 50 | オファー作成時が日本時間22時以上または5時未満 |

`active=false`のルールは新しいスコアスナップショットに含めません。

`DELIVERY_DISTANCE`は距離から動的に作る内訳コードです。店舗から配達先まで500mを超えた分について250mごとに10ポイント、最大100ポイントを加えます。計算結果はほかのルールと一緒にOfferとAssignmentへ固定します。

### ScoreEvent

配達完了で確定した加点履歴です。点数、理由、内訳、発生時刻を保持します。

`assignmentId`が一意であるため、同じAssignmentから複数のScoreEventを作れません。Driverの累計更新と同じDBトランザクションで作成します。

### IdempotencyKey

POST操作の再送による二重実行を防ぎます。

`key + endpoint + driverId`の組み合わせが一意です。処理完了後のJSON応答とHTTP状態コードを保存し、同じキーの再送へ同じ結果を返します。

## 保存しないもの

- Bearerトークン本体
- PINの平文
- ブラウザの位置情報許可状態
- 位置情報の移動履歴
- 道路経路や外部地図サービスの応答
- 天候シミュレーター設定の履歴

天候シミュレーターの現在値はプロセス内だけにあり、再起動すると`CLEAR`へ戻ります。

## SQLiteとPostgreSQL

| 用途 | SQLite | PostgreSQL |
|---|---|---|
| 主な目的 | 手軽な開発、自動テスト | 本番に近いローカル検証 |
| 起動 | `npm start` | Docker Compose |
| Schema | `schema.prisma` | `schema.postgresql.prisma` |
| Migration | `migrations/` | `migrations-postgresql/` |
| データ保存 | ローカルDBファイル | Dockerボリューム |

DBモデルを変更するときは両Schemaと両Migrationを同時に更新し、Prisma Client生成とテストを行います。

## データのライフサイクル

| データ | 作成・更新 | 削除・失効 |
|---|---|---|
| アクセストークンハッシュ | 登録・ログイン | ログアウトで`null` |
| PINハッシュ | 登録 | 現在は削除APIなし |
| 配達位置 | 勤務開始時のデモ位置または勤務中の明示更新 | 退勤時または最終更新から12時間後に全位置項目を`null` |
| Offer | 候補生成 | 削除せず状態で履歴を保持 |
| Assignment | Offer受諾 | 削除せず進行時刻を保持 |
| ScoreEvent | 配達完了 | 削除せず加点履歴を保持 |
| IdempotencyKey | POST操作 | 現在は自動削除なし |

IdempotencyKeyの保存期間は、長期運用前に削除方針を追加する必要があります。
