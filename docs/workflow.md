# 配達ワークフロー

この文書は、配達員・注文・オファーの状態が、画面操作によってどう変わるかを説明します。APIの正確な入出力は[openapi.yaml](openapi.yaml)を参照してください。

## 基本の流れ

```text
配達員登録・ログイン
        ↓
OFFLINE（退勤中）
        │ 稼働開始
        ↓
IDLE（待機中）
        │ オファー確認
        ↓
OFFERED（内容確認中）
   ┌────┴────┐
   │辞退     │受諾
   ↓         ↓
 IDLE      BUSY（配達中）
              │ 荷物受取
              │ 配達完了
              ↓
            IDLE
```

`IDLE`または`OFFERED`では退勤して`OFFLINE`へ戻れます。`BUSY`のまま退勤はできません。

## Driverの状態

| 状態 | 意味 | 実行できる主な操作 |
|---|---|---|
| `OFFLINE` | 退勤中 | 稼働開始、ログアウト |
| `IDLE` | 勤務中・待機中 | 現在地更新、オファー確認、退勤 |
| `OFFERED` | オファー確認中 | 現在地更新、受諾、辞退、オファーを辞退して退勤 |
| `BUSY` | 担当配達あり | 現在地更新、荷物受取、配達完了 |

### Driverの状態遷移

| 操作 | 遷移前 | 遷移後 | 同時に行う処理 |
|---|---|---|---|
| 稼働開始 | `OFFLINE` | `IDLE` | 稼働開始時刻を保存し、候補オファーを用意 |
| オファー確認 | `IDLE` | `OFFERED` | 期限内の保留オファーを表示 |
| 受諾 | `OFFERED` | `BUSY` | Assignmentを作成し、Orderを`ASSIGNED`へ変更 |
| 辞退 | `OFFERED` | `IDLE` | Offerを`REJECTED`へ変更し、次の候補を用意 |
| 配達完了 | `BUSY` | `IDLE` | 完了記録とスコア加算を同じDB処理で確定 |
| 退勤 | `IDLE` / `OFFERED` | `OFFLINE` | 保留Offerを辞退し、稼働時刻と現在地を削除 |

## Orderの状態

```text
CREATED
   │ オファー候補を作成
   ↓
OFFERING
   │ 受諾
   ↓
ASSIGNED
   │ 荷物受取
   ↓
PICKED_UP
   │ 配達完了
   ↓
DELIVERED
```

候補が全員辞退した場合やオファーが期限切れになった場合、保留候補が残っていなければ`OFFERING`から`CREATED`へ戻ります。

## Offerの状態

| 状態 | 意味 |
|---|---|
| `PENDING` | 返答待ち。期限内なら受諾可能 |
| `ACCEPTED` | 配達員が受諾済み |
| `REJECTED` | 配達員が辞退、または退勤時に辞退扱い |
| `EXPIRED` | 有効期限切れ |
| `WITHDRAWN` | 同じ注文を別の候補が受諾したため取り下げ |

受諾時には「自分の`PENDING` Offerである」「期限内である」「Orderが`OFFERING`である」をDB更新条件として再確認します。画面を開いてから状態が変わっていても、二重受諾しません。

## Assignmentの進行

Assignmentは受諾時に1件作られます。進行は時刻とOrder状態の両方で記録します。

| 段階 | Assignment | Order |
|---|---|---|
| 受諾 | `acceptedAt`を保存 | `ASSIGNED` |
| 荷物受取 | `pickedUpAt`を保存 | `PICKED_UP` |
| 配達完了 | `deliveredAt`を保存 | `DELIVERED` |

1つのOrderに作成できるAssignmentは1件です。配達完了前に荷物受取を省略することはできません。

## 現在地の流れ

1. 勤務開始後、配達員が「現在地を更新する」を押します。
2. ブラウザが本人へ位置情報の許可を求めます。
3. 許可された場合だけ、緯度・経度・精度・サーバー更新時刻を保存します。
4. 5分以内なら`FRESH`、5分を超えると`STALE`として扱います。
5. `FRESH`の場合だけ現在地から店舗までの直線距離を計算します。
6. 退勤時に保存中の位置情報をすべて削除します。

`OFFLINE`では現在地を更新できません。正確な配達員座標はダッシュボード応答へ返しません。

## スコア確定の流れ

1. オファー作成時に、有効な`ScoreRule`と天候・日本時間を評価します。
2. 見込み点と内訳をOfferへ保存します。
3. 受諾時に、そのスナップショットをAssignmentへコピーします。
4. 配達完了時にAssignmentの値を使ってScoreEventを1件作成します。
5. 同じトランザクションでDriverの累計スコアを増やします。

オファー表示後に天候や時刻が変わっても、受諾済み配達の点数は変わりません。`ScoreEvent.assignmentId`は一意なので、1配達を二重加点できません。

## 冪等性と再送

配達操作・ログアウト・天候変更など、認証後に状態を変更するPOST APIには`Idempotency-Key`が必要です。配達員登録とログインは対象外です。同じ配達員・エンドポイント・キーの再送には、最初に保存した状態コードと応答を返します。

現在地更新は最新値への上書きであるため`PUT`を使い、`Idempotency-Key`は不要です。

## 主なエラー

| 状況 | 状態コード | エラーコード |
|---|---:|---|
| Bearerトークンがない、または無効 | 401 | `UNAUTHORIZED` |
| 入力値が範囲外 | 400 | `VALIDATION_ERROR` |
| 必要な`Idempotency-Key`がない | 400 | `IDEMPOTENCY_KEY_REQUIRED` |
| 現在の状態では操作できない | 409 | `INVALID_STATE_TRANSITION` |
| オファーが期限切れ・処理済み | 409 | `OFFER_ALREADY_TAKEN` |
| 同じ冪等リクエストを処理中 | 409 | `IDEMPOTENCY_REQUEST_IN_PROGRESS` |
| PIN失敗が短時間に5回以上 | 429 | `TOO_MANY_LOGIN_ATTEMPTS` |

状態変更が失敗した場合は、画面で`GET /api/dashboard`を再取得し、最新状態から操作し直します。
