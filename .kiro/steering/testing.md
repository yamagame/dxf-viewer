# テスト方針

何を・どこで・どう検証するかの規約。ツール設定は `tech.md` を参照。

## 基本方針

- **モックを書かない。** このプロジェクトにモック・スタブ・スパイは一つも存在しない。テストしづらさはテスト技法ではなく設計で解く（後述「テスト容易性は設計で担保する」）
- **振る舞いを検証する。** private フィールドを覗かず、公開メソッドの戻り値と観測可能な状態遷移だけをアサートする
- **テストは仕様の記述である。** 幾何計算の規約（6 桁丸め、交点の扱い）はテストが唯一の明文化された仕様になっている箇所がある
- **カバレッジ率を目標にしない。** 計測ツールは導入していない。DOM 非依存層を厚く、DOM 直結層をゼロで割り切る

## テストの置き場所と粒度

対象モジュールと同階層に `<対象>.test.ts` を置く（コロケーション）。現状 4 ファイル / 16 テスト。

| テストファイル | 対象 |
|---|---|
| `geometry.test.ts` | 純粋関数（距離・交点・正規化） |
| `drawing-model.test.ts` | DXF エンティティ変換、選択可能頂点の算出 |
| `managers.test.ts` | 状態を持つ小さなクラス群をまとめて |
| `viewport-selection.test.ts` | 座標変換を伴うコントローラ |

1 クラス 1 ファイルには**しない**。関連する小さなクラスは `managers.test.ts` のように 1 ファイルへまとめ、座標変換という共通の関心を持つものは `viewport-selection.test.ts` にまとめる。ファイル数ではなく関心で束ねる。

## テスト対象の線引き

**対象とする**: 純粋関数、Controller / Manager クラス
**対象としない**: `DxfViewerApp`（`app.ts`）、`CanvasRenderer`

`app.ts` は DOM 取得とイベント結線に徹しており、判断ロジックを持たないことが前提。`CanvasRenderer` は `ctx` への副作用のみで戻り値を持たない。どちらも検証するには DOM 環境（jsdom 等）が要るが、それは導入していない。

**帰結**: 新しいロジックを `app.ts` に書こうとしたら設計の誤り。Controller / Manager 側へ寄せてテスト可能にする。`app.ts` が肥大化し始めたらテスト範囲が痩せているサイン。

## テスト容易性は設計で担保する

DOM に依存させないための規約。これを守る限りモックは不要になる。

**構造型で受け取る**: `MouseEvent` ではなく `{ clientX: number; clientY: number }` を引数型にする。テストはリテラルを渡すだけで済む。

```typescript
selection.findNearestVertex({ clientX: 5, clientY: 5 }, rect, toCanvas);
```

**変換を関数として注入する**: モデル→キャンバス変換は引数で受け取る。テストでは恒等関数を渡し、変換とヒット判定を分離して検証する。

```typescript
function toCanvas(point: Point): Point {
  return point;  // モデル座標 = キャンバス座標とみなす
}
```

**DOM 型は最小構造だけ満たす**: 実際に読む属性だけを持つオブジェクトをキャストする。

```typescript
const rect = { left: 0, top: 0 } as DOMRect;
```

**固定値はコンストラクタで注入する**: スナップ距離やズーム上下限をクラス内に埋め込まない。テストが境界値を制御できる。

```typescript
new SelectionController(12, 8);      // 頂点スナップ 12px / エッジスナップ 8px
new ViewportController(0.2, 20);     // ズーム下限 / 上限
```

## 命名

- `describe`: 対象のクラス名（`"ViewportController"`）、またはモジュール名（`"drawing-model"`）
- `it`: 英語の平叙文で振る舞いを書く（`"finds nearest vertex after rebuilding candidates"`）。テストコード中の識別子・説明は英語、アサート対象の UI 文字列のみ日本語

## アサーションの規約

**浮動小数は `toBeCloseTo(value, 6)`。** 精度 6 桁は `getVertexKey()` の丸め桁と揃えてある。座標・距離・スケールの比較で `toBe` / `toEqual` を使わない。

```typescript
expect(transform.scale).toBeCloseTo(2, 6);
```

ただし `computeSelectableVertices()` の戻り値のように、`getVertexKey()` を通って既に丸め済みの値は `toContainEqual({ x: 5, y: 5 })` で厳密比較してよい。

**日本語メッセージは `toContain` で部分一致。** 文言の言い回し変更でテストが壊れないよう、意味を担う部分だけを照合する。

```typescript
expect(msg).toContain("距離: 5.000");
expect(msg).toContain("ΔX: 3.000");
```

## テストデータの作法

意図が読み取れる最小の図形を使う。プロジェクト内で繰り返し使う定型:

- **交点を持つ X 字**: `(0,0)-(10,10)` と `(0,10)-(10,0)` → 交点 `(5,5)`。交点検出・頂点列挙の検証に使う
- **3-4-5 の直角三角形**: 距離が厳密に 5 になり、期待値が自明になる
- **レイヤー A / B の 2 本**: 可視フィルタの検証に使う

ランダム値・ループ生成・フィクスチャファイルは使わない。期待値は読んだだけで正しさが判断できる literal で書く。

## 実行

```bash
npm test          # vitest run（ウォッチなし）
npm run typecheck # テストファイルも型チェック対象に含む
```

設定ファイル（`vitest.config.ts`）は置いていない。jsdom を入れる判断をする場合は、その前に「そのロジックは本当に DOM 側にあるべきか」を疑う。

---
_パターンと判断を記述する。ツール設定は tech.md に置く_
