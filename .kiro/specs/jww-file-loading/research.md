# Research & Design Decisions: jww-file-loading

## Summary

- **Feature**: `jww-file-loading`
- **Discovery Scope**: Extension（既存の DXF ビューアへの読み込み経路追加。ただし未知のバイナリ形式を扱うため、形式調査とライブラリ調査はフル相当で実施）
- **Key Findings**:
  - JWW は MFC の `CArchive` シリアライズ形式で、ヘッダ（バージョン分岐あり）→ 図形データリスト（`m_DataList`）→ ブロック定義リスト（`m_DataListList`）の順に並ぶ。公式の形式解説 `jwdatafmt.txt` が LibreCAD 同梱で公開されており、全図形クラスのフィールド順が判明している
  - npm 上の JWW パーサは実質 2 つ。`ezjww`（MIT / Rust+WASM）は公開パッケージが Node 専用ビルド（`require('fs')` で wasm を読む）で、ブラウザ利用には Rust ツールチェーンによる `--target web` の自前ビルドが必要。`jww-parser`（MoonBit 製）は AGPL-3.0。いずれも本プロジェクトの「npm install だけでブラウザ完結」「設定ファイルを置かない」前提を壊す
  - MFC のオブジェクトリストは長さ前置きを持たないため、未対応図形も「読み飛ばす」のではなく「フィールドを正確に消費する」必要がある。対象は `CDataSen` / `CDataEnko` / `CDataTen` / `CDataMoji` / `CDataSunpou` / `CDataSolid` / `CDataBlock` の 7 クラス

## Research Log

### JWW バイナリ形式の構造

- **Context**: 自前実装の可否と、必要な実装範囲を確定するため
- **Sources Consulted**:
  - [jwdatafmt.txt（Jw_cad 5.00a データ形式解説 / LibreCAD jwwlib 同梱）](https://github.com/LibreCAD/LibreCAD/blob/master/libraries/jwwlib/src/jwdatafmt.txt)
  - [jwdatafmt_en.txt（同英訳）](https://github.com/LibreCAD/LibreCAD/blob/master/libraries/jwwlib/src/jwdatafmt_en.txt)
  - [JWWを読む | CAD日記](https://caddiary.com/?p=117)
- **Findings**:
  - 先頭 8 バイトが ASCII `"JwwData."`、続く `DWORD` がデータバージョン（Ver.5.0 = 420、Ver.3.51 = 351 など）
  - ヘッダはファイルメモ（`CString`）、図面サイズ、書込レイヤグループ、16 グループ × {状態・書込レイヤ・縮尺(double)・プロテクト + 16 レイヤ × {状態・プロテクト}}、ダミー 14 個、寸法設定 5 個…と続き、中盤に **レイヤ名 256 個（16×16 の `CString`）**、**レイヤグループ名 16 個（`CString`）**、末尾付近に文字種設定・文字基準点設定が並ぶ
  - レイヤ状態・レイヤグループ状態は `0: 非表示 / 1: 表示のみ / 2: 編集可能 / 3: 書込`
  - バージョン分岐: マークジャンプ 8 個（Ver.3.00 以降、以前は 4 個・`DWORD` 1 個少ない）、文字描画状態ブロック（Ver.3.00 以降）、SXF 対応拡張線色 257 色・拡張線種 33 種（Ver.4.20 以降）、図形の線幅 `WORD`（Ver.3.51 以降）
  - 図形クラスのフィールド順（基底 `CData` = 曲線属性 `DWORD` / 線種 `BYTE` / 線色 `WORD` / 線幅 `WORD`(≥351) / レイヤ `WORD` / レイヤグループ `WORD` / 属性フラグ `WORD`）:
    - `CDataSen`: 始点 x,y・終点 x,y（`double` × 4）
    - `CDataEnko`: 中心 x,y・半径・開始角・円弧角・傾き角・扁平率（`double` × 7）・全円フラグ（`DWORD`）。角度はラジアン
    - `CDataTen`: 点 x,y・仮点フラグ。線種が 100 のときのみ点コード・回転角・倍率が追加
    - `CDataMoji`: 始点/終点 x,y・文字種・サイズ x,y・間隔・角度・フォント名(`CString`)・文字列(`CString`)
    - `CDataSunpou`: 線メンバ + 文字メンバ、Ver.4.20 以降は SXF モード `WORD` + 補助線 2・点 4 のメンバ
    - `CDataSolid`: 4 点の x,y（`double` × 8）、線色が 10 のときのみ RGB `DWORD`
    - `CDataBlock`: 基準点 x,y・倍率 x,y・回転角・定義通し番号（`DWORD`）
  - 文字列は MFC `CString` のシリアライズ（長さ前置き + CP932 バイト列）
- **Implications**:
  - ヘッダをバージョン分岐込みで正確に歩かないと図形リストの開始位置がずれ、以降がすべて壊れる。ヘッダ解析の正確さが本機能の最大リスク
  - 図形リストは長さ前置きがないため、未対応クラスも正確なバイト数を消費する必要がある。「線と円弧だけ実装して他は飛ばす」は成立しない
  - ブロック定義リストは図形リストの後ろにあるため、**読まずに打ち切れる**。`CTime` のシリアライズ幅（32/64bit 差）という不確定要素を回避できる

### 既存ライブラリの調査（build vs adopt）

- **Context**: 「既に解かれている問題か」を確認するため（design-synthesis の Build vs Adopt）
- **Sources Consulted**: npm レジストリ（`npm search jww` / `npm view`）、`ezjww@0.3.2` の実パッケージ展開、[ezjww リポジトリ](https://github.com/monozukuri-ai/ezjww)、[jww-parser](https://www.npmjs.com/package/jww-parser)
- **Findings**:
  - `ezjww@0.3.2`（MIT、2026-09-11 公開）: 型定義は本機能の要求と合致（`JwwHeader.layer_groups[].layers[].state/name`、`JwwEntity.base.layer/layer_group`、円弧の `flatness` / `is_full_circle`、CP932 デコード診断）。しかし同梱 wasm は `wasm-pack --target nodejs` 出力で、グルーコードが `require('fs').readFileSync(wasmPath)` を実行する CommonJS。ブラウザバンドルでは動作しない。リポジトリのブラウザ例は Rust + wasm-pack + pnpm でユーザーが `--target web` ビルドを行う前提。パッケージ実体は wasm 562KB を含み約 600KB
  - `jww-parser@2026.1.7`（MoonBit 製）: ライセンスが AGPL-3.0
  - その他の公開実装（LibreCAD jwwlib(C++)、JwwExchange(C#)、jww-parser(Go)）はブラウザから直接利用できない
- **Implications**: 採用可能な JS/TS ライブラリは存在しない。自前実装を選択し、`jwdatafmt.txt` を一次情報として TypeScript で最小実装する

### ブラウザ・テスト環境での CP932 デコード

- **Context**: レイヤ名（日本語）の文字化け回避（要件 3.6）
- **Findings**: `TextDecoder("shift_jis")` は主要ブラウザの Encoding Standard 実装に含まれ、Node.js も full-icu 同梱ビルド（v14 以降の既定）で利用できる。外部の文字コード変換ライブラリは不要
- **Implications**: 依存追加ゼロで要件 3.6 を満たせる。ただし Vitest（Node）上で動作することを実装時にテストで確認する

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| フォーマット別アダプタ（採用） | `ExtractedDrawData` を共通契約とし、DXF / JWW それぞれに変換モジュールを置く。振り分けは薄いローダ関数 | 既存の DXF 経路に手を入れずに済む。Controller 群は形式を知らないまま動く。テストは形式ごとに閉じる | 共通契約の拡張（レイヤーの可視状態）は DXF 側の呼び出しにも波及 | `structure.md` の「一方向依存」「純粋関数モジュール」に整合 |
| DXF へ変換してから既存経路に流す | JWW を DXF テキストへ変換し `dxf-parser` に渡す | 変換後は既存経路をそのまま再利用 | 変換器の実装量が読み取り実装を上回る。レイヤの表示状態など DXF にない情報が落ちる（要件 3.3 を満たせない） | 不採用 |
| `app.ts` に分岐と解析を直接書く | 追加ファイルを作らない | 変更箇所が 1 ファイル | `testing.md` の「`app.ts` は判断ロジックを持たない」に反し、解析ロジックがテスト不能になる | 不採用 |

## Design Decisions

### Decision: JWW リーダを自前実装する

- **Context**: 要件 2（図形描画）・3（レイヤー）を満たすには JWW のヘッダと図形リストの解析が必要
- **Alternatives Considered**:
  1. `ezjww` を依存に追加する
  2. `jww-parser`（AGPL-3.0）を依存に追加する
  3. TypeScript で必要範囲のみ自前実装する
- **Selected Approach**: 3。`jwdatafmt.txt` に沿って、ヘッダ解析 → 図形リスト解析（7 クラス分のフィールド消費）までを依存ゼロで実装する
- **Rationale**: `ezjww` の公開ビルドは Node 専用で、ブラウザ利用には Rust ツールチェーンと wasm 読み込み設定（= `vite.config.ts`）が要る。これは `tech.md` の「ブラウザ単体で完結」「設定ファイルを置かない」という判断を両方壊す。AGPL-3.0 は本アプリの配布条件を縛る
- **Trade-offs**: 実装量とヘッダ解析の正確性リスクを負う代わりに、依存ゼロ・ビルド構成不変・ライセンス自由を維持する
- **Follow-up**: 実装後に実ファイル（Ver.3.51 系・Ver.4.2 以降系）で目視確認する。`ezjww` がブラウザ向けビルドを公開したら再評価する

### Decision: 解析範囲を「ヘッダ + 図形データリスト」に限定する

- **Context**: ファイル末尾にはブロック定義リストがあるが、ブロック展開は要件のスコープ外
- **Selected Approach**: `m_DataList` を読み終えた時点で解析を終了し、`m_DataListList` 以降は読まない
- **Rationale**: `CDataList` が持つ `CTime` のシリアライズ幅は環境依存で不確定要素が大きい。読まなければリスクごと消える
- **Trade-offs**: 将来ブロック展開を行う場合は解析範囲の拡張が必要
- **Follow-up**: 図形リスト内の `CDataBlock`（ブロック参照）はフィールド消費のみ行う

### Decision: レイヤー識別子に番号アドレスを必ず含める

- **Context**: 要件 3.1 / 3.2。レイヤグループ名・レイヤ名は空のことがあり、異なるアドレスで同名のこともある
- **Alternatives Considered**:
  1. 名前のみを使い、空なら番号で代替する
  2. `グループ番号-レイヤ番号` を常に先頭に付け、名前があれば併記する
- **Selected Approach**: 2。`3-A`（名前なし）、`3-A (平面図/寸法)`（名前あり）のように組み立てる。番号は Jw_cad の表記に合わせ 16 進 1 桁（0〜F）
- **Rationale**: `LayerController` はレイヤー名文字列をキーにしているため、識別子の一意性が表示切替・エッジ選択の正しさの前提になる。アドレス前置きで一意性が構造的に保証される
- **Trade-offs**: 表示名がやや冗長になる
- **Follow-up**: エッジ選択時の表示（要件 4.4）も同じ識別子を使う

### Decision: `ExtractedDrawData.layers` を `DrawingLayer[]` へ一般化する

- **Context**: 要件 3.3（ファイル内の非表示状態を初期値にする）は、現在の `layers: string[]` では表現できない
- **Alternatives Considered**:
  1. `hiddenLayers: string[]` を別フィールドで追加する
  2. `layers: DrawingLayer[]`（`{ name, visible }`）に一般化し、DXF 側は常に `visible: true` を返す
- **Selected Approach**: 2
- **Rationale**: 可視状態の出所が 1 か所に収まり、2 つの配列の整合を保つ責務が生まれない。DXF は「すべて可視」という特殊ケースとして自然に収まる
- **Trade-offs**: `extractDrawData` / `LayerController.setLayers` と既存テスト 2 ファイルの更新が必要
- **Follow-up**: 既存テストのアサーション更新をタスクに含める

### Decision: 読み込みの振り分けとメッセージ生成を `drawing-loader.ts` に置く

- **Context**: `testing.md` は「`app.ts` に判断ロジックを書くのは設計の誤り」と定める。形式判定・エラー分類・ユーザー向け文言は判断ロジック
- **Selected Approach**: `loadDrawing({ fileName, bytes })` が判別可能ユニオンを返し、`app.ts` は結果を DOM に流すだけにする。`app.ts` は `File.arrayBuffer()` の取得のみを担当する
- **Rationale**: `structure.md` の「ユーザー向けメッセージはロジック層が返す」と一致し、形式判定・エラー文言をテストできる
- **Trade-offs**: DXF 経路も `file.text()` から `TextDecoder` 経由に変わる（UTF-8 デコードとして等価）

## Risks & Mitigations

- **ヘッダのバージョン分岐を読み違えると図形リスト全体が壊れる** — 図形リストの先頭で要素数とクラスタグを検証し、既知のクラス名でなければ即座にバイト位置付きで失敗させる。無音の誤描画より明示的な失敗を優先する
- **検証用ファイルのバージョンが仕様書の範囲外** — 手元のサンプル 3 件はいずれもデータバージョン **700**（Jw_cad 7 系）で、一次情報 `jwdatafmt.txt` が記述する Ver.5.0（420）より新しい。LibreCAD jwwlib はバージョン分岐を 230 / 300 / 351 / 420 の 4 点のみ持ち、420 以降を同一レイアウトとして扱っているため、700 も「420 以降」の分岐で読める見込み。ただしこれは仮説であり、ヘッダ走査後の位置が図形リスト先頭と一致するか（タスク 2.3 の完了条件）を実ファイルで確認して確定させる
- **想定外のバージョン（将来版・旧版）** — バージョン値を読み取り、分岐が未知の場合も解析を試みたうえで、失敗時は要件 5.3 のメッセージに倒す
- **`TextDecoder("shift_jis")` が Vitest（Node）で使えない環境がある** — レイヤ名デコードのユニットテストで早期に検出する。使えない場合は最小の CP932 変換表をテスト用に用意するのではなく、実装側の代替（バイト列のまま表示）を検討する
- **実ファイルでの検証不足** — ユニットテストは合成バイト列で行うため、実 JWW ファイルでの目視確認を完了条件に含める。検証用ファイルは利用者提供の 3 件（`private/` 配下、いずれもバージョン 700 の建築平面図、205〜385 KB）。`private/` は `.gitignore` で除外されており、リポジトリにコミットしない
- **扁平率・全円フラグの実値ぶれ** — 真円判定は `|扁平率 - 1| <= 1e-9` と全円フラグの組み合わせで行い、判定外は描画対象から除外する（要件 2.3）

## References

- [jwdatafmt.txt — Jw_cad データ形式解説（LibreCAD jwwlib 同梱）](https://github.com/LibreCAD/LibreCAD/blob/master/libraries/jwwlib/src/jwdatafmt.txt) — 本設計の一次情報。ヘッダ順・図形クラスのフィールド順
- [jwdatafmt_en.txt — 同英訳](https://github.com/LibreCAD/LibreCAD/blob/master/libraries/jwwlib/src/jwdatafmt_en.txt) — 用語確認
- [ezjww（MIT / Rust+WASM）](https://github.com/monozukuri-ai/ezjww) — 採用見送りの根拠（npm 公開ビルドが Node 専用）
- [jww-parser（AGPL-3.0 / MoonBit）](https://www.npmjs.com/package/jww-parser) — 採用見送りの根拠（ライセンス）
- [JWWを読む | CAD日記](https://caddiary.com/?p=117) — シグネチャとバージョン値の確認
- [Encoding Standard — TextDecoder ラベル](https://encoding.spec.whatwg.org/#names-and-labels) — `shift_jis` ラベルの標準性
