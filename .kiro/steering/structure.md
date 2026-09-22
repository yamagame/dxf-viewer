# プロジェクト構成

## 構成方針

**フラット・責務分割型**。ソースはリポジトリ直下に置き、`src/` などの階層を作らない。規模が小さいためディレクトリで分類せず、1 ファイル 1 責務という粒度で分割する。ファイル名がそのまま責務名になる。

新しい関心事が生まれたら、既存ファイルを肥大化させずに直下へ新規ファイルを作る。

## ファイルの役割パターン

### エントリポイント / オーケストレーション
**対象**: `app.ts`
**役割**: DOM 要素の取得、イベント束ね、各 Controller の生成と協調、描画の起動。DOM とブラウザ API に触れてよい唯一の層。
**特徴**: `DxfViewerApp` クラスが全ての状態と依存を private フィールドとして保持し、イベントハンドラはアロー関数プロパティで定義して `this` を束縛する。

### 純粋関数モジュール
**対象**: `geometry.ts`, `drawing-model.ts`
**役割**: 型定義と、状態を持たない計算。座標演算・交点計算、描画データの共通契約の型と DXF エンティティの変換。
**規約**: クラスを持たず `export function` / `export type` のみ。DOM を参照しない。後述の形式アダプタもこの規約に従う。

### 形式アダプタ
**対象**: `drawing-loader.ts`（形式の振り分け）, `jww-parser.ts` / `jww-drawing.ts`（JWW の解釈と変換）
**役割**: 入力ファイル形式ごとの解釈を、描画データの共通契約 `ExtractedDrawData` に写す。ファイル形式を知るのはこの層と `drawing-model.ts` の DXF 変換部（`extractDrawData()`）までで、Controller / Renderer / Manager には形式非依存のデータだけが渡る。
**規約**:
- 解釈は「バイト（テキスト）読取 → 形式構造 → 描画データ化」の段に分け、各段は下位段の型だけに依存する
- 形式の判定はファイル名の拡張子で行い、内容のスニッフィングはしない
- 読み込み結果の分類（成功 / 対応形式外 / 対応要素なし / 解析失敗）は振り分け側が返す。対応形式外・対応要素なし・解析失敗の文言も振り分け側が持ち、`app.ts` は表示するだけ。読み込み中・完了メッセージ（ファイル名・要素数・レイヤー数）は表示側で組み立てる
- 形式を増やすときは既存アダプタを書き換えず、新しいアダプタを追加して振り分けに分岐を足す

### 読み取りカーソル
**対象**: `jww-archive-reader.ts`
**役割**: バイナリ形式のバイト列を先頭から順に読み進める。現在のバイト位置という状態と、型ごとの読み取りメソッド（`readWord()` / `readDouble()` / `readString()` など）だけを持つ。
**規約**:
- 持つ状態はカーソル位置に限る。ヘッダ項目や図形種別といった形式の意味づけは持たず、上位の解釈層に任せる
- 範囲外の読み取りはバイト位置を伴う例外として投げ、無音で誤った値を返さない
- 複数の読み取りを組み合わせるメソッドは、途中で失敗したらカーソルを開始位置へ戻す
- **クラスにするのはこの層だけ**。未知バイナリの解析は位置という可変状態を必要とするためクラス化するが、その上の解釈・変換層は純粋関数モジュールに保つ

### Controller / Manager クラス
**対象**: `viewport-controller.ts`, `selection-controller.ts`, `layer-controller.ts`, `measurement-manager.ts`, `edge-selection-manager.ts`
**役割**: 一つの関心事についての可変状態と、その状態遷移メソッドを持つ。
**規約**:
- フィールドは `private`。外部へは取得メソッド経由で公開する
- 固定値（スナップ距離、ズーム上下限など）はコンストラクタ引数で注入し、クラス内にハードコードしない
- DOM を参照しない。座標変換が必要な場合は `modelToCanvas` のような関数を引数で受け取る
- イベントオブジェクトは `{ clientX, clientY }` の構造型で受け取り、`MouseEvent` 等に依存しない
- 状態をリセットする `clear()` / `reset()` を持つ

### 描画
**対象**: `canvas-renderer.ts`
**役割**: `DrawCommand[]` と `ViewTransform`、オーバーレイ状態を受け取って Canvas に描く。状態を持たず、`ctx` のみをコンストラクタで受け取る。

### テスト
**対象**: `*.test.ts`（対象モジュールと同階層）
**役割**: 純粋関数とロジッククラスの検証。

## 命名規約

- **ファイル名**: kebab-case（`viewport-controller.ts`）。テストは `<対象>.test.ts`
- **クラス名**: PascalCase。責務に応じ `〜Controller` / `〜Manager` / `〜Renderer` / `〜Reader`（読み取りカーソル）を接尾辞とする
- **型 / 型エイリアス**: PascalCase（`DrawCommand`, `ViewTransform`, `Bounds`）
- **関数 / メソッド / 変数**: camelCase
- **定数**: UPPER_SNAKE_CASE（`INTERSECTION_EPSILON`）
- **DOM 要素を保持する変数**: 末尾に `El` を付ける（`statusEl`, `edgeInfoEl`）

## import 規約

パスエイリアスは設定していない。すべて相対パスの拡張子なし指定。

```typescript
import DxfParser from "dxf-parser";                  // 外部依存を先頭
import { getVertexKey, type Point } from "./geometry"; // 値と型の混在は type 修飾子
import type { DrawCommand } from "./drawing-model";    // 型のみなら import type
import { LayerController } from "./layer-controller";  // クラス
```

順序は「外部依存 → 純粋関数モジュール → クラス」。

## 設計原則

- **依存方向は一方向**: `app.ts` → Controller / Renderer → `drawing-model.ts` → `geometry.ts`、および `app.ts` → 形式アダプタ（振り分け → 描画データ化 → 形式解釈 → 読み取りカーソル）→ `drawing-model.ts` → `geometry.ts`。逆向きの import を作らない。`geometry.ts` は何にも依存しない
- **DOM は app.ts に閉じる**: Controller が DOM を知らないことがテスト可能性の前提。DOM が必要な処理は `app.ts` 側に置き、判断ロジックだけを Controller に渡す
- **ユーザー向けメッセージはロジック層が返す**: 状態遷移メソッドが表示文字列を戻り値として返し、`app.ts` はそれを DOM に流し込むだけ（例: `MeasurementManager.selectPoint()`、`loadDrawing()` の失敗・対応形式外メッセージ）
- **ファイル由来の値は境界で正規化する**: レイヤー識別子は描画データ化のときに確定させる（DXF は `extractDrawData()` 内の `normalizeLayerName()`、JWW はレイヤグループとレイヤの番号から `formatJwwLayerName()`）。レイヤー名を照合する側も同じ `normalizeLayerName()` を通す。座標の同一性は `getVertexKey()` を必ず通す

## メタディレクトリ

`.kiro/steering/`（プロジェクトメモリ）と `.kiro/specs/`（機能仕様）はソースコードではない。実装ファイルと同じ規約の対象外。

---
_ファイルツリーではなくパターンを記述する。パターンに従う新規ファイルで更新が不要であること_
