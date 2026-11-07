# Session Compass

[English](README.md) | 日本語

Claude Code のプロンプトの上に帯を出すプラグインです。帯の左側には、このセッションで何をしているかが出ます。これまでの依頼をまとめた 1 行の要約か、チケットに取り組むセッションならそのチケットの ID とタイトルです。右側には、会話の中の自分のプロンプトを行き来するボタンが並びます（⏫ 最初へ、🔼 前へ、🔽 次へ、⏬ 最新へ）。要約はセッションの進み方に合わせて作り直され（プロンプトのたびに、または 🔁 を押したときだけ。設定で選べます）、Claude からの質問ダイアログの上にも出ます。

## 動き

### 要約

- プロンプトを送るたびに、最初のプロンプトと直近のプロンプト（最大 8 件）から要約を作り直します。話題が移れば要約もそれに合わせて変わります。要約はモデル（haiku）の呼び出しで作ります。
- 新しい要約を作っている間や、作るのに失敗したときは、前の要約を表示したままにします。
- スラッシュコマンドは、引数があるとき（`/graph-ops:process-ticket SCMP-00001` など）は依頼に数えます。引数の無いもの（`/clear`、`/config` など）は数えません。
- `manual` モード（[`summaryMode`](#summarymode) を参照）でも、最初の要約は自動で作ります。それ以降は、帯の 🔁 を押したときだけ作り直します。
- 要約はテーマの `claude` 色の太字で表示します。ライト／ダークどちらのテーマでも、通常の文字と見分けやすくしています。

### チケット

プロンプトがチケットへの対応を頼むものなら、そのセッションの間は要約の代わりにチケットを表示します。

- チケットとは、プロンプトの中の `SCMP-00001` や `PROJ-123` のような ID です。`UTF-8` や `RFC-2119` のような規格名・バージョンはチケットと見なしません。
- スラッシュコマンドの引数にある ID は、そのチケットへの対応を頼むものと見なします。普通の文章の中にある ID は、モデルの呼び出しで判定します。「PROJ-123 を直して」ならチケットに固定し、「PROJ-12 の仕様ってどうなってたっけ」なら固定しません。
- タイトルは、課題管理ツールの種類を問わず、チケットに取り組むスキルやツールが読み込んだ内容から取ります。
  - ツールの結果にチケットの情報（ID を `id` や `key` などで持ち、`title`・`summary`・`subject`・`name` のいずれかを持つ JSON。graph-ops の `get-ticket` や Jira の `fields.summary` など）があれば、モデルを使わずにタイトルを取ります。ツールの実行が終わるたびに探します
  - 見つからなければ、ターンの終わりに、会話のうち ID に触れた部分から haiku に探させます。ツールの結果を優先し、ID への言及が増えたときだけ探し直します（最大 5 回）
  - [graph-ops](https://github.com/imahiro-t/graph-ops) のチケットは、見つけた時点で `graph-engine get-ticket <ID>` も実行します（`graph-engine` が PATH にある場合）
  - 見つかるまでは ID だけを表示します
- ID はテーマの `suggestion` 色、タイトルは `claude` 色で表示します。

### ボタン

- ⏫ は最初のプロンプトへ、⏬ は最新のプロンプトへ、🔼 と 🔽 は 1 つ前・1 つ後のプロンプトへ移動します。移動先は自分のプロンプトだけで、通知や他のエージェントからのメッセージなどは含みません。
- 移動すると、そのプロンプトの行が会話欄の一番上に来ます。
- 会話欄を自分でスクロールしたあとは、いま読んでいる位置から数えます。🔼 は画面に出ている返答のプロンプトの先頭へ戻り、🔽 は次のプロンプトへ進みます。スクロールしていなければ、最後にボタンで移動した位置から数えます。

### 質問ダイアログ（AskUserQuestion）の表示中

質問ダイアログが出ている間はプロンプトの場所がダイアログになり、帯も隠れます。そのときは、チケットまたは要約をダイアログの上に 1 行で表示します（ダイアログの行数には上限があるため、短く切ります）。ボタンは表示しません。

### 送信されるもの

- 要約のために、最初のプロンプトと直近のプロンプト（各 600 文字まで）を haiku に送ります。`auto` ではプロンプトのたび、`manual` では 🔁 を押したときです。
- スラッシュコマンドの引数ではない所にチケット ID を含むプロンプトは、チケットへの対応の依頼かを判定するため、haiku に 1 回送ります。
- ツールの結果からタイトルの取れないチケットについては、会話のうち ID の前後（最大 6,000 文字）を、ターンの終わりに haiku に送ります。前回より ID への言及が増えたときだけで、最大 5 回です。
- チケット ID が見つかったとき、手元のマシンで `graph-engine get-ticket <ID>` を実行します。`graph-engine` が入っていなければ何も起きません。

## インストール

このリポジトリはそれ自体がマーケットプレイスです（`.claude-plugin/marketplace.json`、名前は `session-compass`）。Claude Code のターミナルセッションのプロンプトで、次を実行します。

```
/plugin marketplace add imahiro-t/session-compass
/plugin install session-compass@session-compass
```

1. プラグインの詳細が表示されたら、スコープを選びます（ユーザースコープなら以降のすべてのセッションで有効になります）
2. 設定画面で `summaryMode` を選びます（初期値は `auto`）
3. `Installed session-compass. Plugin is now active.` と表示されたら、そのセッションですぐに使えます

Session Compass は [erin-the-black-plugins](https://github.com/imahiro-t/claude-plugins) マーケットプレイスにも登録されています（そちらからインストールした場合、下の設定例のキーは `session-compass@session-compass` ではなく `session-compass@erin-the-black-plugins` になります）。インストールはどちらか一方のマーケットプレイスからだけにしてください。両方から入れるとフックが二重に登録され、帯が 2 つのプラグインから描かれます。乗り換えるときは、先に入っている方をアンインストールしてください。

## 設定（userConfig）

### `summaryMode`

帯の要約をどう作り直すか。`auto`（初期値）か `manual` です。

| 値 | 動き |
| --- | --- |
| `auto` | プロンプトを送るたびに要約を作り直します |
| `manual` | 最初のプロンプトの要約は自動で作ります。それ以降は、帯の 🔁 を押したときだけ作り直します。新しいプロンプトが無くても、🔁 を押せば作り直します |

チケットのセッションでは 🔁 は出ません。`/config` から変えるか、設定ファイルに書きます。

```json
{
  "pluginConfigs": {
    "session-compass@session-compass": {
      "options": { "summaryMode": "manual" }
    }
  }
}
```

## 既知の制限

- 会話欄の上部に出る Claude Code 自身の表示（スクロール中に、いま読んでいるプロンプトを示すもの）が、🔽 で移動した先の 1 つ前のプロンプトを示すことがあります。この表示は Claude Code のもので、このプラグインは手を加えません。
- 再開したセッションでは、そのあとに送ったプロンプトからだけチケットを判別します。それより前のスラッシュコマンドからは判別しません。

## 開発

開発中は、このフォルダからデバッグログ付きで読み込んで動かします。

```sh
claude --debug --plugin-dir .
```

ファイルを保存すると、そのセッションでプラグインが読み込み直されます。変更を入れる前に、次で確認します。

```sh
claude plugin validate .
claude plugin test .
```

## リリース手順

1. `.claude-plugin/plugin.json` の `version` を上げ、その変更を `main` にマージする
2. その `main` のコミットに `vX.Y.Z` のタグを付けて push する: `git tag vX.Y.Z && git push origin vX.Y.Z`
3. [imahiro-t/claude-plugins](https://github.com/imahiro-t/claude-plugins) の `.claude-plugin/marketplace.json` で、`session-compass` のエントリの `ref` を新しいタグにする
4. claude-plugins のルートで `claude plugin validate .` を実行し、通ったらその変更を claude-plugins の `main` に入れる
5. （任意）一時的な設定ディレクトリで、erin-the-black-plugins からのインストールを試す。どのコマンドにも同じディレクトリを使う:

   ```sh
   TMP=$(mktemp -d)
   CLAUDE_CONFIG_DIR="$TMP" claude plugin marketplace add imahiro-t/claude-plugins
   CLAUDE_CONFIG_DIR="$TMP" claude plugin install session-compass@erin-the-black-plugins
   rm -rf "$TMP"
   ```

タグは、`ref` の変更が claude-plugins の `main` に入る前に push してください。タグが無い間は erin-the-black-plugins からのインストールが失敗し、`claude plugin validate .` はそれを検出しません。

## ライセンス

MIT
