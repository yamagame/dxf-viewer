import { describe, expect, it } from "vitest";
import { JwwArchiveReader, JwwParseError } from "./jww-archive-reader";
import { isJwwSignature, parseJww } from "./jww-parser";

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

function reader(values: number[]): JwwArchiveReader {
  return new JwwArchiveReader(new Uint8Array(values).buffer);
}

// CP932 bytes for "平面図" (a typical Japanese layer name).
const CP932_HEIMENZU = [0x95, 0xbd, 0x96, 0xca, 0x90, 0x7d];
// CP932 bytes for "建具" and "躯体", two more double-byte layer names.
const CP932_TATEGU = [0x8c, 0x9a, 0x8b, 0xef];
const CP932_KUTAI = [0x8b, 0xeb, 0x91, 0xcc];
// CP932 bytes for "ｺﾝｸﾘｰﾄ", half-width katakana held in single bytes.
const CP932_KONKURITO = [0xba, 0xdd, 0xb8, 0xd8, 0xb0, 0xc4];

describe("JwwArchiveReader", () => {
  it("exposes the buffer length and starts at offset zero", () => {
    const archive = reader([0x01, 0x02, 0x03]);
    expect(archive.byteLength).toBe(3);
    expect(archive.offset).toBe(0);
  });

  it("reads an ascii signature and little-endian integers in order", () => {
    const archive = reader([
      ...ascii("JwwData."),
      ...u32(700),
      0x2a,
      ...u16(0x1234),
    ]);

    expect(archive.readAscii(8)).toBe("JwwData.");
    expect(archive.offset).toBe(8);
    expect(archive.readDword()).toBe(700);
    expect(archive.offset).toBe(12);
    expect(archive.readByte()).toBe(0x2a);
    expect(archive.offset).toBe(13);
    expect(archive.readWord()).toBe(0x1234);
    expect(archive.offset).toBe(15);
  });

  it("reads doubles as little-endian ieee 754 values", () => {
    const archive = reader([...f64(1.5), ...f64(-0.125)]);

    expect(archive.readDouble()).toBeCloseTo(1.5, 6);
    expect(archive.readDouble()).toBeCloseTo(-0.125, 6);
    expect(archive.offset).toBe(16);
  });

  it("skips the requested number of bytes", () => {
    const archive = reader([0x01, 0x02, 0x03, 0x04]);

    archive.skip(3);
    expect(archive.offset).toBe(3);
    expect(archive.readByte()).toBe(0x04);
  });

  it("reads a string with a byte length prefix", () => {
    const archive = reader([0x02, ...ascii("AB"), 0x63]);

    expect(archive.readString()).toBe("AB");
    expect(archive.offset).toBe(3);
    expect(archive.readByte()).toBe(0x63);
  });

  it("reads an empty string as a zero length prefix", () => {
    const archive = reader([0x00, 0x7f]);

    expect(archive.readString()).toBe("");
    expect(archive.offset).toBe(1);
    expect(archive.readByte()).toBe(0x7f);
  });

  it("decodes string bytes as cp932 japanese text", () => {
    const archive = reader([0x06, ...CP932_HEIMENZU, 0x02, ...ascii("XY")]);

    expect(archive.readString()).toBe("平面図");
    expect(archive.offset).toBe(7);
    expect(archive.readString()).toBe("XY");
  });

  it("reads a string whose length prefix escapes to a word", () => {
    const archive = reader([0xff, ...u16(3), ...ascii("JWW"), 0x11]);

    expect(archive.readString()).toBe("JWW");
    expect(archive.offset).toBe(6);
    expect(archive.readByte()).toBe(0x11);
  });

  it("reads a string whose length prefix escapes through a word to a dword", () => {
    const archive = reader([
      0xff,
      ...u16(0xffff),
      ...u32(2),
      ...ascii("AB"),
      0x12,
    ]);

    expect(archive.readString()).toBe("AB");
    expect(archive.offset).toBe(9);
    expect(archive.readByte()).toBe(0x12);
  });

  it("reads a count as a word", () => {
    const archive = reader([...u16(3), 0x44]);

    expect(archive.readCount()).toBe(3);
    expect(archive.offset).toBe(2);
    expect(archive.readByte()).toBe(0x44);
  });

  it("reads a count that escapes to a dword", () => {
    const archive = reader([...u16(0xffff), ...u32(70000), 0x45]);

    expect(archive.readCount()).toBe(70000);
    expect(archive.offset).toBe(6);
    expect(archive.readByte()).toBe(0x45);
  });

  it("reads a null object tag", () => {
    const archive = reader([...u16(0x0000), 0x55]);

    expect(archive.readObjectTag()).toEqual({ kind: "null" });
    expect(archive.offset).toBe(2);
    expect(archive.readByte()).toBe(0x55);
  });

  it("reads a new class object tag with its schema and class name", () => {
    const archive = reader([
      ...u16(0xffff),
      ...u16(1),
      ...u16(8),
      ...ascii("CDataSen"),
      0x66,
    ]);

    expect(archive.readObjectTag()).toEqual({
      kind: "new-class",
      schema: 1,
      className: "CDataSen",
    });
    expect(archive.offset).toBe(14);
    expect(archive.readByte()).toBe(0x66);
  });

  it("reads a class reference object tag with the class tag bit masked off", () => {
    const archive = reader([...u16(0x8002), 0x77]);

    expect(archive.readObjectTag()).toEqual({ kind: "class-ref", classIndex: 2 });
    expect(archive.offset).toBe(2);
    expect(archive.readByte()).toBe(0x77);
  });

  it("throws a parse error with the byte offset when a read runs past the end", () => {
    const archive = reader([...u32(700)]);
    expect(archive.readDword()).toBe(700);

    expect(() => archive.readByte()).toThrow(JwwParseError);
    expect(archive.offset).toBe(4);

    try {
      archive.readByte();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(4);
      expect((error as JwwParseError).message).toContain("バイト位置 4");
    }
  });

  it("leaves the offset unchanged when a string body runs past the end", () => {
    const archive = reader([0x04, ...ascii("AB")]);

    try {
      archive.readString();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(1);
    }
    expect(archive.offset).toBe(0);
  });

  it("leaves the offset unchanged when an object tag name runs past the end", () => {
    const archive = reader([...u16(0xffff), ...u16(1), ...u16(8), ...ascii("CData")]);

    try {
      archive.readObjectTag();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(6);
    }
    expect(archive.offset).toBe(0);
  });

  it("throws a parse error when a skip runs past the end", () => {
    const archive = reader([0x01, 0x02]);

    expect(() => archive.skip(3)).toThrow(JwwParseError);
    expect(archive.offset).toBe(0);
  });

  it("allows reading up to the exact end of the buffer", () => {
    const archive = reader([...u16(9)]);

    expect(archive.readWord()).toBe(9);
    expect(archive.offset).toBe(archive.byteLength);
  });
});

type SyntheticLayer = { state?: number; protect?: number; name?: number[] };

type SyntheticLayerGroup = {
  state?: number;
  writeLayer?: number;
  scale?: number;
  protect?: number;
  name?: number[];
  layers?: SyntheticLayer[];
};

type SyntheticJwwFile = {
  signature?: string;
  version?: number;
  memo?: number[];
  drawingSize?: number;
  writeGroup?: number;
  groups?: SyntheticLayerGroup[];
  rest?: number[];
};

const LAYER_GROUP_COUNT = 16;
const LAYER_COUNT = 16;

// A version 700 file whose memo and names are all empty: 2389 bytes up to the
// end of the layer state block (8 signature + 4 version + 1 memo + 4 drawing
// size + 4 write group + 16 x 148 state bytes) plus 11706 bytes of remaining
// header items, of which 9758 are the Ver.4.20 extended color and line type
// definitions.
const VERSION_700_HEADER_BYTES = 14095;
// Ver.3.51 keeps every Ver.3.00 item but drops the 9758 bytes of Ver.4.20
// extended definitions.
const VERSION_351_HEADER_BYTES = 4337;
// Ver.2.30 additionally drops the sky view condition (16 bytes), the text draw
// state block (56 bytes) and four of the eight mark jumps (128 bytes).
const VERSION_230_HEADER_BYTES = 4137;
// The header's last item is the six doubles of text base point offsets.
const TEXT_BASE_POINT_OFFSET_BYTES = 48;

function cstring(bytes: number[]): number[] {
  return [bytes.length, ...bytes];
}

function zeroBytes(count: number): number[] {
  return new Array(count).fill(0);
}

// Filler for header items the parser only has to step over. A zero byte run is
// a valid run of zero-valued DWORDs, doubles or empty length-prefixed strings.
function zeroDwords(count: number): number[] {
  return zeroBytes(count * 4);
}

function zeroDoubles(count: number): number[] {
  return zeroBytes(count * 8);
}

function emptyStrings(count: number): number[] {
  return zeroBytes(count);
}

function layerBytes(layer: SyntheticLayer): number[] {
  return [...u32(layer.state ?? 2), ...u32(layer.protect ?? 0)];
}

function layerGroupBytes(group: SyntheticLayerGroup): number[] {
  const bytes = [
    ...u32(group.state ?? 2),
    ...u32(group.writeLayer ?? 0),
    ...f64(group.scale ?? 1),
    ...u32(group.protect ?? 0),
  ];
  for (let index = 0; index < LAYER_COUNT; index += 1) {
    bytes.push(...layerBytes(group.layers?.[index] ?? {}));
  }
  return bytes;
}

function layerNameBytes(file: SyntheticJwwFile): number[] {
  const bytes: number[] = [];
  for (let group = 0; group < LAYER_GROUP_COUNT; group += 1) {
    for (let layer = 0; layer < LAYER_COUNT; layer += 1) {
      bytes.push(...cstring(file.groups?.[group]?.layers?.[layer]?.name ?? []));
    }
  }
  return bytes;
}

function layerGroupNameBytes(file: SyntheticJwwFile): number[] {
  const bytes: number[] = [];
  for (let group = 0; group < LAYER_GROUP_COUNT; group += 1) {
    bytes.push(...cstring(file.groups?.[group]?.name ?? []));
  }
  return bytes;
}

// The header items that follow the layer state block, in the order the format
// description (jwdatafmt.txt) and jwwdoc.cpp::ReadHeader() serialize them.
function headerRemainderBytes(file: SyntheticJwwFile): number[] {
  const version = file.version ?? 700;
  const bytes = [
    ...zeroDwords(14), // ダミー
    ...zeroDwords(5), // 寸法関係の設定
    ...zeroDwords(1), // ダミー
    ...zeroDwords(1), // 線描画の最大幅
    ...zeroDoubles(3), // プリンタ出力範囲の原点 x, y と出力倍率
    ...zeroDwords(2), // プリンタ 90 度回転出力、目盛設定モード
    ...zeroDoubles(5), // 目盛の表示最小間隔、表示間隔 x, y、基準点 x, y
    ...layerNameBytes(file),
    ...layerGroupNameBytes(file),
    ...zeroDoubles(2), // 日影計算の測定面高さ、緯度
    ...zeroDwords(1), // 日影計算の 9〜15 時の測定指定
    ...zeroDoubles(1), // 壁面日影の測定面高さ
  ];
  if (version >= 300) {
    bytes.push(...zeroDoubles(2)); // 天空図の測定面高さ、半径
  }
  bytes.push(
    ...zeroDwords(1), // 2.5D の計算単位
    ...zeroDoubles(6) // 保存時の画面倍率と原点、範囲記憶の倍率と基準点
  );
  if (version >= 300) {
    for (let index = 0; index < 8; index += 1) {
      bytes.push(...zeroDoubles(3), ...zeroDwords(1)); // マークジャンプ
    }
    bytes.push(
      ...zeroDoubles(3),
      ...zeroDwords(1),
      ...zeroDoubles(3),
      ...zeroDwords(1) // 文字の描画状態
    );
  } else {
    for (let index = 0; index < 4; index += 1) {
      bytes.push(...zeroDoubles(3)); // マークジャンプ（レイヤグループなし）
    }
  }
  bytes.push(
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
    ...zeroDwords(2) // ソリッドの任意色フラグと既定色
  );
  if (version >= 420) {
    bytes.push(...zeroDwords(2 * 257)); // 拡張線色の画面表示色と線幅
    for (let index = 0; index <= 256; index += 1) {
      bytes.push(...emptyStrings(1), ...zeroDwords(2), ...zeroDoubles(1));
    }
    bytes.push(...zeroDwords(4 * 33)); // 拡張線種のパターン
    for (let index = 0; index <= 32; index += 1) {
      bytes.push(...emptyStrings(1), ...zeroDwords(1), ...zeroDoubles(10));
    }
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

// Assembles a synthetic JWW file. Unspecified fields take defaults, and `rest`
// is the seam where the entity list is appended.
function buildJwwFile(file: SyntheticJwwFile = {}): ArrayBuffer {
  const bytes = [
    ...ascii(file.signature ?? "JwwData."),
    ...u32(file.version ?? 700),
    ...cstring(file.memo ?? []),
    ...u32(file.drawingSize ?? 1),
    ...u32(file.writeGroup ?? 0),
  ];
  for (let index = 0; index < LAYER_GROUP_COUNT; index += 1) {
    bytes.push(...layerGroupBytes(file.groups?.[index] ?? {}));
  }
  bytes.push(...headerRemainderBytes(file));
  bytes.push(...(file.rest ?? []));
  return new Uint8Array(bytes).buffer;
}

function bufferOf(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("parseJww", () => {
  it("recognizes a buffer that starts with the jww signature", () => {
    expect(isJwwSignature(buildJwwFile())).toBe(true);
    expect(isJwwSignature(bufferOf(ascii("DxfData.")))).toBe(false);
    expect(isJwwSignature(bufferOf(ascii("Jww")))).toBe(false);
  });

  it("reads the data version, the file memo and the layer group block", () => {
    const document = parseJww(
      buildJwwFile({
        version: 700,
        memo: CP932_HEIMENZU,
        groups: [
          {
            state: 3,
            scale: 100,
            layers: [{ state: 3 }, { state: 0 }, { state: 1 }],
          },
          { state: 0, scale: 50 },
        ],
      })
    );

    expect(document.header.version).toBe(700);
    expect(document.header.memo).toBe("平面図");
    expect(document.header.groups[0].state).toBe(3);
    expect(document.header.groups[0].scale).toBeCloseTo(100, 6);
    expect(document.header.groups[0].layers[0].state).toBe(3);
    expect(document.header.groups[0].layers[1].state).toBe(0);
    expect(document.header.groups[0].layers[2].state).toBe(1);
    expect(document.header.groups[0].layers[3].state).toBe(2);
    expect(document.header.groups[1].state).toBe(0);
    expect(document.header.groups[1].scale).toBeCloseTo(50, 6);
    expect(document.header.groups[2].scale).toBeCloseTo(1, 6);
  });

  it("returns sixteen layer groups that each carry sixteen layers", () => {
    const document = parseJww(buildJwwFile());

    expect(document.header.groups).toHaveLength(16);
    expect(document.header.groups[15].layers).toHaveLength(16);
    expect(
      document.header.groups.every((group) => group.layers.length === 16)
    ).toBe(true);
  });

  it("leaves the layer names and the entity list empty", () => {
    const document = parseJww(buildJwwFile());

    expect(document.header.groups[0].name).toBe("");
    expect(document.header.groups[0].layers[0].name).toBe("");
    expect(document.entities).toEqual([]);
    expect(document.skippedCount).toBe(0);
  });

  it("throws a parse error at offset zero when the signature does not match", () => {
    const buffer = buildJwwFile({ signature: "DxfData." });

    expect(() => parseJww(buffer)).toThrow(JwwParseError);

    try {
      parseJww(buffer);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(0);
      expect((error as JwwParseError).message).toContain("署名");
    }
  });

  it("throws a parse error at offset zero when the buffer is shorter than the signature", () => {
    try {
      parseJww(bufferOf(ascii("Jww")));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(0);
      expect((error as JwwParseError).message).toContain("署名");
    }
  });

  it("throws a parse error when the data version is outside the readable range", () => {
    try {
      parseJww(buildJwwFile({ version: 100 }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(8);
      expect((error as JwwParseError).message).toContain("バージョン");
    }
  });

  it("reads the oldest readable data version", () => {
    expect(parseJww(buildJwwFile({ version: 230 })).header.version).toBe(230);
  });

  it("throws a parse error when a layer state is outside the valid range", () => {
    try {
      parseJww(buildJwwFile({ groups: [{ layers: [{ state: 4 }] }] }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).message).toContain("レイヤ状態");
    }
  });

  it("throws a parse error when a layer group state is outside the valid range", () => {
    try {
      parseJww(buildJwwFile({ groups: [{ state: 9 }] }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).message).toContain("レイヤグループ状態");
    }
  });

  it("reads layer names and layer group names at their matching addresses", () => {
    const document = parseJww(
      buildJwwFile({
        groups: [
          {
            name: CP932_HEIMENZU,
            layers: [
              { name: CP932_TATEGU },
              {},
              { name: ascii("S-1") },
              { name: CP932_KONKURITO },
            ],
          },
          { layers: [{ name: CP932_KUTAI }] },
        ],
      })
    );

    expect(document.header.groups[0].name).toContain("平面図");
    expect(document.header.groups[0].layers[0].name).toContain("建具");
    expect(document.header.groups[0].layers[1].name).toBe("");
    expect(document.header.groups[0].layers[2].name).toBe("S-1");
    expect(document.header.groups[0].layers[3].name).toContain("ｺﾝｸﾘｰﾄ");
    expect(document.header.groups[1].name).toBe("");
    expect(document.header.groups[1].layers[0].name).toContain("躯体");
    expect(document.header.groups[1].layers[1].name).toBe("");
    expect(document.header.groups[15].name).toBe("");
    expect(document.header.groups[15].layers[15].name).toBe("");
  });

  it("keeps layer states and layer names aligned on the same address", () => {
    const document = parseJww(
      buildJwwFile({
        groups: [
          { layers: [{ state: 0, name: CP932_TATEGU }] },
          { state: 0, name: CP932_HEIMENZU, layers: [{ state: 3 }] },
        ],
      })
    );

    expect(document.header.groups[0].layers[0].state).toBe(0);
    expect(document.header.groups[0].layers[0].name).toContain("建具");
    expect(document.header.groups[1].state).toBe(0);
    expect(document.header.groups[1].name).toContain("平面図");
    expect(document.header.groups[1].layers[0].state).toBe(3);
    expect(document.header.groups[1].layers[0].name).toBe("");
  });

  it("ends the header walk at the first byte of the entity list", () => {
    const header = buildJwwFile();
    expect(header.byteLength).toBe(VERSION_700_HEADER_BYTES);
    expect(parseJww(header).header.version).toBe(700);

    try {
      parseJww(header.slice(0, VERSION_700_HEADER_BYTES - 1));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(
        VERSION_700_HEADER_BYTES - TEXT_BASE_POINT_OFFSET_BYTES
      );
    }
  });

  it("leaves the entity list that follows the header unread", () => {
    const document = parseJww(
      buildJwwFile({
        groups: [{ name: CP932_HEIMENZU }],
        rest: [
          ...u16(2),
          ...u16(0xffff),
          ...u16(0),
          ...u16(8),
          ...ascii("CDataSen"),
        ],
      })
    );

    expect(document.header.groups[0].name).toContain("平面図");
    expect(document.entities).toEqual([]);
    expect(document.skippedCount).toBe(0);
  });

  it("omits the extended color and line type definitions below version 420", () => {
    const header = buildJwwFile({ version: 351 });
    expect(header.byteLength).toBe(VERSION_351_HEADER_BYTES);
    expect(parseJww(header).header.version).toBe(351);

    try {
      parseJww(header.slice(0, VERSION_351_HEADER_BYTES - 1));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(
        VERSION_351_HEADER_BYTES - TEXT_BASE_POINT_OFFSET_BYTES
      );
    }
  });

  it("omits the sky view, the extended mark jumps and the text draw state below version 300", () => {
    const header = buildJwwFile({ version: 230 });
    expect(header.byteLength).toBe(VERSION_230_HEADER_BYTES);
    expect(parseJww(header).header.version).toBe(230);

    try {
      parseJww(header.slice(0, VERSION_230_HEADER_BYTES - 1));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(
        VERSION_230_HEADER_BYTES - TEXT_BASE_POINT_OFFSET_BYTES
      );
    }
  });

  it("throws a parse error with the byte offset when the file ends inside the layer state block", () => {
    // 8 signature + 4 version + 1 empty memo + 4 drawing size + 4 write group
    // = 21, plus the first group's 4 + 4 + 8 + 4 = 20 leading bytes, so the
    // file ends exactly where the first layer state would begin.
    const buffer = buildJwwFile().slice(0, 41);

    try {
      parseJww(buffer);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(JwwParseError);
      expect((error as JwwParseError).offset).toBe(41);
      expect((error as JwwParseError).message).toContain("バイト位置 41");
    }
  });
});
