# 技術スタック

## アーキテクチャ

バックエンドを持たないクライアントサイド専用の SPA。`index.html` が DOM の骨格を静的に定義し、`app.ts` の `DxfViewerApp` クラスがそれらの要素を取得して制御する。UI フレームワークは使用せず、DOM 操作と Canvas 2D API を直接扱う。

データフローは一方向:

```
DXF ファイル → DxfParser → extractDrawData()
  → DrawCommand[] / Segment[] / layers / bounds
  → 各 Controller が状態を保持
  → CanvasRenderer が描画
```

`extractDrawData()` が DXF エンティティを描画用の `DrawCommand`（Canvas への描画命令）と判定用の `Segment`（線分の集合）に二分する点が中核の設計判断。描画と当たり判定で別表現を持つことで、円弧を線分化せずに描画しつつ、選択・交点計算は線分だけを対象にできる。

## コア技術

- **言語**: TypeScript（ES2020 ターゲット、ESNext モジュール、Bundler 解決）
- **ビルド/開発サーバー**: Vite
- **テスト**: Vitest
- **描画**: Canvas 2D API（WebGL / SVG は使用しない）
- **UI**: 素の DOM + CSS（フレームワーク・状態管理ライブラリなし）

## 主要ライブラリ

- **dxf-parser**: DXF テキストを JS オブジェクトへ変換する唯一の実行時依存。パーサ出力は型が緩いため、`extractDrawData()` の中でのみ `any` として扱い、境界の外へは自前の型（`DrawCommand` / `Segment` / `Bounds`）だけを流す

新規の実行時依存を追加する際は、「ブラウザ単体で完結する」という前提を崩さないか確認する。

## 開発標準

### 型安全性

`tsconfig.json` は `strict: false` / `noImplicitAny: false`。全面的な strict 化は行っていないが、新規コードでは以下を守る:

- 公開する関数・メソッドには引数と戻り値の型を明示する
- データ構造は `type` エイリアスで定義し、`geometry.ts` / `drawing-model.ts` に集約する
- `any` は外部パーサ出力の受け口に限定する
- 型のみの import は `import type` / インライン `type` 修飾子を使う

### コード品質

Linter / Formatter は未導入。既存コードのスタイル（2 スペースインデント、ダブルクォート、セミコロンあり）に合わせる。

### テスト

- テストは対象モジュールと同階層に `*.test.ts` として置く
- 対象は純粋関数とロジッククラス。DOM / Canvas に依存しない層だけをテストする（jsdom 等の DOM 環境は導入していない）
- `DxfViewerApp` は DOM 直結のためテスト対象外。ロジックを追加する場合は Controller / Manager 側へ寄せてテスト可能にする
- ユーザー向けメッセージ文字列は戻り値としてアサートする

## 開発環境

### 必要なツール

- Node.js（Vite / Vitest が動作するバージョン）
- npm

### 主なコマンド

```bash
npm install      # 依存インストール
npm run dev      # 開発サーバー起動（既定 http://localhost:5173）
npm run build    # 本番ビルド
npm run preview  # ビルド結果のプレビュー
npm run typecheck # 型チェック（tsc --noEmit）
npm test         # ユニットテスト（vitest run）
```

## 主要な技術判断

- **設定ファイルを置かない**: `vite.config.ts` / `vitest.config.ts` は作らず、既定動作に委ねている。設定が必要になった時点で初めて追加する
- **描画命令と線分の二重表現**: 上記アーキテクチャ参照。CIRCLE / ARC は `DrawCommand` のみを持ち `Segment` を持たないため、現状は選択・交点計算の対象外
- **座標系の反転は描画側で行う**: DXF はスクリーンと Y 軸の向きが逆。モデル座標は変換せず保持し、`ViewportController.getTransform()` が返す変換を適用する時点（`-y * scale + offsetY`）で反転する
- **頂点の同一判定はキー文字列で行う**: `getVertexKey()` が小数 6 桁に丸めた `"x:y"` 文字列を生成し、これを唯一の同一性基準とする。浮動小数の誤差による頂点の重複を防ぐため、頂点の重複排除・照合は必ずこの関数を経由する

---
_標準とパターンを記述する。依存関係の全列挙はしない_
