import { describe, expect, it } from "vitest";
import { loadDrawing, type LoadDrawingResult } from "./drawing-loader";
import { LayerController } from "./layer-controller";

// CP932 bytes for the Japanese layer and group names used below. The header
// stores names as CP932, and TextEncoder only emits UTF-8, so the bytes are
// written out literally.
const CP932_HEIMENZU = [0x95, 0xbd, 0x96, 0xca, 0x90, 0x7d]; // "平面図"
const CP932_SUNPOU = [0x90, 0xa1, 0x96, 0x40]; // "寸法"
const CP932_RITSUMENZU = [0x97, 0xa7, 0x96, 0xca, 0x90, 0x7d]; // "立面図"

const UNSUPPORTED_MESSAGE = "対応していないファイル形式です。DXFまたはJWWファイルを選択してください。";
const EMPTY_MESSAGE = "対応エンティティが見つかりませんでした。";
const DXF_FAILED_MESSAGE = "DXFの解析に失敗しました。ファイル形式を確認してください。";
const JWW_FAILED_MESSAGE = "JWWの解析に失敗しました。ファイル形式を確認してください。";

// 扁平率 0.6404397415169785 は実ファイル 3 件に存在した楕円記号の値。
const REAL_ELLIPSE_FLATNESS = 0.6404397415169785;

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function f64(value: number): number[] {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, true);
  return Array.from(new Uint8Array(buffer));
}

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

// MFC CString: a byte length prefix followed by the raw CP932 bytes.
function cstring(bytes: number[]): number[] {
  return [bytes.length, ...bytes];
}

function zeroDwords(count: number): number[] {
  return new Array(count * 4).fill(0);
}

function zeroDoubles(count: number): number[] {
  return new Array(count * 8).fill(0);
}

// A run of zero bytes is also a run of empty length-prefixed strings.
function emptyStrings(count: number): number[] {
  return new Array(count).fill(0);
}

const LAYER_GROUP_COUNT = 16;
const LAYER_COUNT = 16;
// レイヤ状態 2 は表示、0 は非表示として保存されたレイヤ。
const VISIBLE_LAYER_STATE = 2;
const HIDDEN_LAYER_STATE = 0;

type SyntheticLayer = { state?: number; name?: number[] };

type SyntheticGroup = { name?: number[]; layers?: Record<number, SyntheticLayer> };

type SyntheticAddress = { group?: number; layer?: number };

type SyntheticLine = SyntheticAddress & {
  type: "line";
  from: { x: number; y: number };
  to: { x: number; y: number };
};

type SyntheticArc = SyntheticAddress & {
  type: "arc";
  center: { x: number; y: number };
  radius: number;
  startAngle: number;
  sweepAngle: number;
  flatness?: number;
  fullCircle?: boolean;
};

type SyntheticText = SyntheticAddress & { type: "text" };

type SyntheticEntity = SyntheticLine | SyntheticArc | SyntheticText;

type SyntheticJwwFile = {
  groups?: Record<number, SyntheticGroup>;
  entities?: SyntheticEntity[];
};

// レイヤグループ 1 件は 148 バイト（状態・書込レイヤ・縮尺・プロテクト +
// 16 レイヤ × {状態, プロテクト}）。16 グループで 2368 バイトのブロックになる。
function layerGroupBytes(group: SyntheticGroup): number[] {
  const bytes = [
    ...u32(VISIBLE_LAYER_STATE), // レイヤグループ状態
    ...u32(0), // 書込レイヤ
    ...f64(100), // 縮尺
    ...u32(0), // プロテクト指定
  ];
  for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
    bytes.push(
      ...u32(group.layers?.[layer]?.state ?? VISIBLE_LAYER_STATE),
      ...u32(0) // プロテクト指定
    );
  }
  return bytes;
}

// レイヤ名 256 件は group-major、その直後にレイヤグループ名 16 件が並ぶ。
function layerNameBytes(file: SyntheticJwwFile): number[] {
  const bytes: number[] = [];
  for (let group = 0; group < LAYER_GROUP_COUNT; group += 1) {
    for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
      bytes.push(...cstring(file.groups?.[group]?.layers?.[layer]?.name ?? []));
    }
  }
  for (let group = 0; group < LAYER_GROUP_COUNT; group += 1) {
    bytes.push(...cstring(file.groups?.[group]?.name ?? []));
  }
  return bytes;
}

// レイヤ状態ブロックの直後から図形データリストの直前まで。すべて Ver.7.00
// （つまり Ver.3.00 以降かつ Ver.4.20 以降）の並びで、値はゼロで埋める。
function headerRemainderBytes(file: SyntheticJwwFile): number[] {
  const bytes = [
    ...zeroDwords(14), // ダミー
    ...zeroDwords(5), // 寸法関係の設定
    ...zeroDwords(1), // ダミー
    ...zeroDwords(1), // 線描画の最大幅
    ...zeroDoubles(3), // プリンタ出力範囲の原点 x, y と出力倍率
    ...zeroDwords(2), // プリンタ 90 度回転出力、目盛設定モード
    ...zeroDoubles(5), // 目盛の表示最小間隔、表示間隔 x, y、基準点 x, y
    ...layerNameBytes(file),
    ...zeroDoubles(2), // 日影計算の測定面高さ、緯度
    ...zeroDwords(1), // 日影計算の 9〜15 時の測定指定
    ...zeroDoubles(1), // 壁面日影の測定面高さ
    ...zeroDoubles(2), // 天空図の測定面高さ、半径
    ...zeroDwords(1), // 2.5D の計算単位
    ...zeroDoubles(6), // 保存時の画面倍率と原点、範囲記憶の倍率と基準点
  ];
  for (let index = 0; index < 8; index += 1) {
    bytes.push(...zeroDoubles(3), ...zeroDwords(1)); // マークジャンプ
  }
  bytes.push(
    ...zeroDoubles(3),
    ...zeroDwords(1),
    ...zeroDoubles(3),
    ...zeroDwords(1), // 文字の描画状態
    ...zeroDoubles(11), // 複線間隔 10 件と両側複線の留線出寸法
    ...zeroDwords(20) // 色番号ごとの画面表示色と線幅
  );
  for (let index = 0; index < 10; index += 1) {
    bytes.push(...zeroDwords(2), ...zeroDoubles(1)); // プリンタ出力色、線幅、実点半径
  }
  bytes.push(
    ...zeroDwords(32), // 線種番号 2〜9
    ...zeroDwords(25), // ランダム線 1〜5
    ...zeroDwords(16), // 倍長線種番号 6〜9
    ...zeroDwords(16), // 描画・印刷の指定 12 件、2.5D 視点フラグ、視点水平角 3 件
    ...zeroDoubles(5), // 2.5D の透視図・鳥瞰図・アイソメ図の視点
    ...zeroDoubles(4), // 線の長さ、矩形寸法 x, y、円の半径の最終値
    ...zeroDwords(2), // ソリッドの任意色フラグと既定色
    ...zeroDwords(2 * 257) // 拡張線色の画面表示色と線幅
  );
  for (let index = 0; index < 257; index += 1) {
    bytes.push(...emptyStrings(1), ...zeroDwords(2), ...zeroDoubles(1)); // 拡張線色
  }
  bytes.push(...zeroDwords(4 * 33)); // 拡張線種のパターン
  for (let index = 0; index < 33; index += 1) {
    bytes.push(...emptyStrings(1), ...zeroDwords(1), ...zeroDoubles(10)); // 拡張線種
  }
  for (let index = 0; index < 10; index += 1) {
    bytes.push(...zeroDoubles(3), ...zeroDwords(1)); // 文字種 1〜10
  }
  bytes.push(
    ...zeroDoubles(3), // 書込み文字の文字幅、高さ、間隔
    ...zeroDwords(2), // 書込み文字の色番号、文字番号
    ...zeroDoubles(2), // 文字位置整理の行間、文字数
    ...zeroDwords(1), // 文字基準点のずれ位置使用フラグ
    ...zeroDoubles(6) // 文字基準点の横方向と縦方向のずれ位置
  );
  return bytes;
}

function entityClassName(entity: SyntheticEntity): string {
  if (entity.type === "line") return "CDataSen";
  if (entity.type === "arc") return "CDataEnko";
  return "CDataMoji";
}

// 図形基底 CData。Ver.3.51 以降なので線幅 WORD を含む 15 バイト。
function dataBaseBytes(entity: SyntheticEntity): number[] {
  return [
    ...u32(0), // 曲線属性番号
    1, // 線種番号
    ...u16(1), // 線色番号
    ...u16(1), // 線幅
    ...u16(entity.layer ?? 0),
    ...u16(entity.group ?? 0),
    ...u16(0), // 属性フラグ
  ];
}

function entityBodyBytes(entity: SyntheticEntity): number[] {
  if (entity.type === "line") {
    return [
      ...f64(entity.from.x),
      ...f64(entity.from.y),
      ...f64(entity.to.x),
      ...f64(entity.to.y),
    ];
  }
  if (entity.type === "arc") {
    return [
      ...f64(entity.center.x),
      ...f64(entity.center.y),
      ...f64(entity.radius),
      ...f64(entity.startAngle),
      ...f64(entity.sweepAngle),
      ...f64(0), // 傾き角
      ...f64(entity.flatness ?? 1),
      ...u32(entity.fullCircle === true ? 1 : 0),
    ];
  }
  return [
    ...zeroDoubles(4), // 始点 x, y と終点 x, y
    ...u32(3), // 文字種
    ...zeroDoubles(4), // 文字サイズ横、縦、文字間隔、角度
    ...cstring([]), // フォント名
    ...cstring([]), // 文字列
  ];
}

// 図形データリストの MFC オブジェクトタグ。クラスは初出時に読み込み配列の 1 枠を
// 取り、その直後の実体がもう 1 枠を取る（インデックス 0 は null タグ用の予約）。
function entityListBytes(entities: SyntheticEntity[]): number[] {
  const classIndexes = new Map<string, number>();
  let nextIndex = 1;
  const bytes = [...u16(entities.length)];
  for (const entity of entities) {
    const className = entityClassName(entity);
    const registered = classIndexes.get(className);
    if (registered === undefined) {
      classIndexes.set(className, nextIndex);
      nextIndex += 1;
      bytes.push(
        ...u16(0xffff), // wNewClassTag
        ...u16(1), // スキーマ
        ...u16(className.length),
        ...ascii(className)
      );
    } else {
      bytes.push(...u16(0x8000 | registered)); // wClassTag | 読み込み配列の番号
    }
    nextIndex += 1;
    bytes.push(...dataBaseBytes(entity), ...entityBodyBytes(entity));
  }
  return bytes;
}

// Ver.7.00 の合成 JWW ファイル。未指定のレイヤは表示状態・名前なしになる。
function buildJwwFile(file: SyntheticJwwFile = {}): ArrayBuffer {
  const bytes = [
    ...ascii("JwwData."),
    ...u32(700), // データバージョン
    ...cstring([]), // ファイルのメモ
    ...u32(1), // 図面サイズ
    ...u32(0), // 書込レイヤグループ
  ];
  for (let group = 0; group < LAYER_GROUP_COUNT; group += 1) {
    bytes.push(...layerGroupBytes(file.groups?.[group] ?? {}));
  }
  bytes.push(...headerRemainderBytes(file));
  bytes.push(...entityListBytes(file.entities ?? []));
  return new Uint8Array(bytes).buffer;
}

function bufferOf(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function dxfBytes(codes: string[]): ArrayBuffer {
  return bufferOf(Array.from(new TextEncoder().encode(codes.join("\n"))));
}

// 交点を持つ X 字の 2 本を ENTITIES セクションに持つ最小の DXF。
const X_CROSS_DXF = dxfBytes([
  "0", "SECTION", "2", "ENTITIES",
  "0", "LINE", "8", "A", "10", "0", "20", "0", "30", "0", "11", "10", "21", "10", "31", "0",
  "0", "LINE", "8", "B", "10", "0", "20", "10", "30", "0", "11", "10", "21", "0", "31", "0",
  "0", "ENDSEC", "0", "EOF",
]);

// 判別可能ユニオンを status で絞り込むための型付きアサーション。
function expectStatus<S extends LoadDrawingResult["status"]>(
  result: LoadDrawingResult,
  status: S
): Extract<LoadDrawingResult, { status: S }> {
  expect(result.status).toBe(status);
  return result as Extract<LoadDrawingResult, { status: S }>;
}

describe("drawing-loader", () => {
  it("detects the jww and dxf formats regardless of the extension case", () => {
    const jww = buildJwwFile({
      entities: [{ type: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }],
    });

    const upperJww = expectStatus(
      loadDrawing({ fileName: "図面.JWW", bytes: jww }),
      "loaded"
    );
    expect(upperJww.format).toBe("jww");
    expect(upperJww.data.commands).toHaveLength(1);

    const mixedJww = expectStatus(
      loadDrawing({ fileName: "図面.Jww", bytes: jww }),
      "loaded"
    );
    expect(mixedJww.format).toBe("jww");

    const upperDxf = expectStatus(
      loadDrawing({ fileName: "PLAN.DXF", bytes: X_CROSS_DXF }),
      "loaded"
    );
    expect(upperDxf.format).toBe("dxf");
    expect(upperDxf.data.commands).toHaveLength(2);
  });

  it("reports an unsupported format without parsing files that are neither dxf nor jww", () => {
    // 中身は解析可能な JWW。拡張子だけで振り分けるため unsupported になる。
    const jww = buildJwwFile({
      entities: [{ type: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }],
    });

    const result = expectStatus(
      loadDrawing({ fileName: "drawing.txt", bytes: jww }),
      "unsupported"
    );
    expect(result.message).toBe(UNSUPPORTED_MESSAGE);
    expect("format" in result).toBe(false);
    expect("data" in result).toBe(false);

    expect(loadDrawing({ fileName: "drawing", bytes: jww }).status).toBe("unsupported");
    expect(loadDrawing({ fileName: "drawing.jww.txt", bytes: jww }).status).toBe(
      "unsupported"
    );
    expect(loadDrawing({ fileName: "drawing.dxf.bak", bytes: X_CROSS_DXF }).status).toBe(
      "unsupported"
    );
  });

  it("builds a command and a segment for every jww line and a command only for arcs", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          entities: [
            { type: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            { type: "line", from: { x: 0, y: 10 }, to: { x: 10, y: 0 } },
            {
              type: "arc",
              center: { x: 20, y: 0 },
              radius: 5,
              startAngle: Math.PI / 6,
              sweepAngle: Math.PI / 2,
            },
            {
              type: "arc",
              center: { x: -10, y: 0 },
              radius: 2,
              startAngle: 0,
              sweepAngle: 0,
              fullCircle: true,
            },
          ],
        }),
      }),
      "loaded"
    );

    const { commands, segments, bounds } = result.data;
    expect(commands.map((command) => command.type)).toEqual([
      "line",
      "line",
      "arc",
      "circle",
    ]);
    // 円と円弧は測定・選択の対象外なので Segment を持たない。
    expect(segments).toHaveLength(2);

    const firstLine = commands[0];
    if (firstLine.type !== "line") throw new Error("expected a line command");
    expect(firstLine.from.x).toBeCloseTo(0, 6);
    expect(firstLine.from.y).toBeCloseTo(0, 6);
    expect(firstLine.to.x).toBeCloseTo(10, 6);
    expect(firstLine.to.y).toBeCloseTo(10, 6);

    expect(segments[1].from.x).toBeCloseTo(0, 6);
    expect(segments[1].from.y).toBeCloseTo(10, 6);
    expect(segments[1].to.x).toBeCloseTo(10, 6);
    expect(segments[1].to.y).toBeCloseTo(0, 6);

    const arc = commands[2];
    if (arc.type !== "arc") throw new Error("expected an arc command");
    expect(arc.center.x).toBeCloseTo(20, 6);
    expect(arc.center.y).toBeCloseTo(0, 6);
    expect(arc.radius).toBeCloseTo(5, 6);
    expect(arc.start).toBeCloseTo(Math.PI / 6, 6);
    // 終了角は開始角 + 円弧角。π/6 + π/2 = 2π/3。
    expect(arc.end).toBeCloseTo((2 * Math.PI) / 3, 6);

    const circle = commands[3];
    if (circle.type !== "circle") throw new Error("expected a circle command");
    expect(circle.center.x).toBeCloseTo(-10, 6);
    expect(circle.center.y).toBeCloseTo(0, 6);
    expect(circle.radius).toBeCloseTo(2, 6);

    // 境界は線の端点と、円・円弧の中心 ± 半径から求まる。
    expect(bounds).not.toBeNull();
    expect(bounds!.minX).toBeCloseTo(-12, 6);
    expect(bounds!.minY).toBeCloseTo(-5, 6);
    expect(bounds!.maxX).toBeCloseTo(25, 6);
    expect(bounds!.maxY).toBeCloseTo(10, 6);
  });

  it("drops arcs whose flatness is not one and keeps the other figures of the file", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          entities: [
            { type: "line", from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            {
              type: "arc",
              center: { x: 0, y: 0 },
              radius: 5,
              startAngle: 0,
              sweepAngle: Math.PI,
              flatness: 0.5,
            },
            // テキストは描画対象として保持される。
            { type: "text" },
            {
              type: "arc",
              center: { x: 0, y: 0 },
              radius: 5,
              startAngle: 0,
              sweepAngle: 0,
              flatness: REAL_ELLIPSE_FLATNESS,
              fullCircle: true,
            },
            {
              type: "arc",
              center: { x: 2, y: 3 },
              radius: 4,
              startAngle: 0,
              sweepAngle: Math.PI / 2,
              flatness: 1,
            },
          ],
        }),
      }),
      "loaded"
    );

    const { commands, segments, bounds } = result.data;
    expect(commands.map((command) => command.type)).toEqual(["line", "text", "arc"]);
    expect(segments).toHaveLength(1);

    const arc = commands[2];
    if (arc.type !== "arc") throw new Error("expected an arc command");
    expect(arc.center.x).toBeCloseTo(2, 6);
    expect(arc.center.y).toBeCloseTo(3, 6);
    expect(arc.radius).toBeCloseTo(4, 6);

    // 除外された 2 つの円弧（中心 (0,0) 半径 5）は境界にも寄与しない。
    expect(bounds!.minX).toBeCloseTo(-2, 6);
    expect(bounds!.minY).toBeCloseTo(-1, 6);
    expect(bounds!.maxX).toBeCloseTo(10, 6);
    expect(bounds!.maxY).toBeCloseTo(10, 6);
  });

  it("names a layer by its address and by whichever of the group and layer names is set", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          groups: {
            0: { layers: { 5: { name: CP932_SUNPOU } } },
            1: { layers: { 5: { name: CP932_SUNPOU } } },
            3: {
              name: CP932_HEIMENZU,
              layers: { 10: { name: CP932_SUNPOU } },
            },
          },
          entities: [
            { type: "line", group: 3, layer: 11, from: { x: 0, y: 0 }, to: { x: 1, y: 0 } },
            { type: "line", group: 0, layer: 5, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
            { type: "line", group: 3, layer: 10, from: { x: 0, y: 0 }, to: { x: 1, y: 2 } },
            { type: "line", group: 2, layer: 10, from: { x: 0, y: 0 }, to: { x: 1, y: 3 } },
            { type: "line", group: 1, layer: 5, from: { x: 0, y: 0 }, to: { x: 1, y: 4 } },
          ],
        }),
      }),
      "loaded"
    );

    // アドレスは 16 進大文字で前置きされ、同名の 0-5 と 1-5 も一意になる。
    // 並びはアドレスの数値昇順（グループ → レイヤ）で、図形の出現順ではない。
    expect(result.data.layers.map((layer) => layer.name)).toEqual([
      "0-5 (寸法)",
      "1-5 (寸法)",
      "2-A",
      "3-A (平面図/寸法)",
      "3-B (平面図)",
    ]);
    expect(result.data.layers.every((layer) => layer.visible)).toBe(true);
  });

  it("gives commands, segments and the layer list the same layer identifier", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          groups: {
            3: { name: CP932_HEIMENZU, layers: { 10: { name: CP932_SUNPOU } } },
          },
          entities: [
            { type: "line", group: 3, layer: 10, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            {
              type: "arc",
              group: 3,
              layer: 10,
              center: { x: 0, y: 0 },
              radius: 5,
              startAngle: 0,
              sweepAngle: Math.PI,
            },
          ],
        }),
      }),
      "loaded"
    );

    const { commands, segments, layers } = result.data;
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe("3-A (平面図/寸法)");
    expect(commands[0].layer).toBe(layers[0].name);
    expect(commands[1].layer).toBe(layers[0].name);
    expect(segments[0].layer).toBe(layers[0].name);
  });

  it("marks a layer saved as hidden as not visible and keeps it hidden after loading", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          groups: {
            0: {
              layers: {
                0: { state: VISIBLE_LAYER_STATE, name: CP932_HEIMENZU },
                1: { state: HIDDEN_LAYER_STATE, name: CP932_RITSUMENZU },
              },
            },
          },
          entities: [
            { type: "line", layer: 0, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            { type: "line", layer: 1, from: { x: 0, y: 10 }, to: { x: 10, y: 0 } },
          ],
        }),
      }),
      "loaded"
    );

    expect(result.data.layers).toEqual([
      { name: "0-0 (平面図)", visible: true },
      { name: "0-1 (立面図)", visible: false },
    ]);

    const controller = new LayerController();
    controller.setLayers(result.data.layers);
    expect(controller.isVisible("0-0 (平面図)")).toBe(true);
    expect(controller.isVisible("0-1 (立面図)")).toBe(false);
    expect(controller.filterVisibleCommands(result.data.commands)).toHaveLength(1);
    expect(controller.filterVisibleSegments(result.data.segments)).toHaveLength(1);
  });

  it("returns the layer list when every layer of the file is hidden", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({
          groups: {
            0: {
              layers: {
                0: { state: HIDDEN_LAYER_STATE },
                1: { state: HIDDEN_LAYER_STATE },
              },
            },
          },
          entities: [
            { type: "line", layer: 0, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
            { type: "line", layer: 1, from: { x: 0, y: 10 }, to: { x: 10, y: 0 } },
          ],
        }),
      }),
      "loaded"
    );

    expect(result.data.layers).toEqual([
      { name: "0-0", visible: false },
      { name: "0-1", visible: false },
    ]);
    expect(result.data.commands).toHaveLength(2);

    const controller = new LayerController();
    controller.setLayers(result.data.layers);
    expect(controller.getLayerNames()).toEqual(["0-0", "0-1"]);
    // 一覧は出るが何も描かれない。利用者が表示に切り替えれば描画対象になる。
    expect(controller.filterVisibleCommands(result.data.commands)).toHaveLength(0);
    controller.setVisible("0-0", true);
    expect(controller.filterVisibleCommands(result.data.commands)).toHaveLength(1);
  });

  it("loads text-only JWW files as drawable content", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.jww",
        bytes: buildJwwFile({ entities: [{ type: "text" }, { type: "text" }] }),
      }),
      "loaded"
    );

    expect(result.data.commands.map((command) => command.type)).toEqual(["text", "text"]);
    expect(result.data.bounds).not.toBeNull();
  });

  it("reports an empty result when the dxf file holds no supported entity", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.dxf",
        bytes: dxfBytes(["0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF"]),
      }),
      "empty"
    );

    expect(result.message).toBe(EMPTY_MESSAGE);
  });

  it("reports a jww parse failure for bytes that are not a readable jww file", () => {
    // 署名がそもそも合わない（DXF テキストを .jww として渡した場合を含む）。
    const notJww = expectStatus(
      loadDrawing({ fileName: "plan.jww", bytes: X_CROSS_DXF }),
      "failed"
    );
    expect(notJww.message).toBe(JWW_FAILED_MESSAGE);
    expect("data" in notJww).toBe(false);

    // 署名は合うがヘッダの手前で尽きている。
    const truncated = expectStatus(
      loadDrawing({ fileName: "plan.jww", bytes: bufferOf(ascii("JwwData.")) }),
      "failed"
    );
    expect(truncated.message).toBe(JWW_FAILED_MESSAGE);
  });

  it("reports a dxf parse failure with the dxf message", () => {
    const result = expectStatus(
      loadDrawing({
        fileName: "plan.dxf",
        bytes: dxfBytes(["0", "SECTION", "2", "ENTITIES", "0", "LINE", "8"]),
      }),
      "failed"
    );

    expect(result.message).toBe(DXF_FAILED_MESSAGE);
  });

  it("loads dxf bytes as before with every layer visible", () => {
    const result = expectStatus(
      loadDrawing({ fileName: "plan.dxf", bytes: X_CROSS_DXF }),
      "loaded"
    );

    expect(result.format).toBe("dxf");
    const { commands, segments, layers, bounds } = result.data;
    expect(commands.map((command) => command.type)).toEqual(["line", "line"]);
    expect(segments).toHaveLength(2);
    expect(layers).toEqual([
      { name: "A", visible: true },
      { name: "B", visible: true },
    ]);
    expect(bounds!.minX).toBeCloseTo(0, 6);
    expect(bounds!.minY).toBeCloseTo(0, 6);
    expect(bounds!.maxX).toBeCloseTo(10, 6);
    expect(bounds!.maxY).toBeCloseTo(10, 6);
  });
});
