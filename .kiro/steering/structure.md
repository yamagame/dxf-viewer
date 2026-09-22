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
**役割**: 型定義と、状態を持たない計算。座標演算・交点計算・DXF エンティティの変換。
**規約**: クラスを持たず `export function` / `export type` のみ。DOM を参照しない。

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
- **クラス名**: PascalCase。責務に応じ `〜Controller` / `〜Manager` / `〜Renderer` を接尾辞とする
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

- **依存方向は一方向**: `app.ts` → Controller / Renderer → `drawing-model.ts` → `geometry.ts`。逆向きの import を作らない。`geometry.ts` は何にも依存しない
- **DOM は app.ts に閉じる**: Controller が DOM を知らないことがテスト可能性の前提。DOM が必要な処理は `app.ts` 側に置き、判断ロジックだけを Controller に渡す
- **ユーザー向けメッセージはロジック層が返す**: 状態遷移メソッドが表示文字列を戻り値として返し、`app.ts` はそれを DOM に流し込むだけ（例: `MeasurementManager.selectPoint()`）
- **DXF 由来の値は境界で正規化する**: レイヤー名は `normalizeLayerName()`、座標の同一性は `getVertexKey()` を必ず通す

## メタディレクトリ

`.kiro/steering/`（プロジェクトメモリ）と `.kiro/specs/`（機能仕様）はソースコードではない。実装ファイルと同じ規約の対象外。

---
_ファイルツリーではなくパターンを記述する。パターンに従う新規ファイルで更新が不要であること_
