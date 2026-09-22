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

type SyntheticLayer = { state?: number; protect?: number };

type SyntheticLayerGroup = {
  state?: number;
  writeLayer?: number;
  scale?: number;
  protect?: number;
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

function cstring(bytes: number[]): number[] {
  return [bytes.length, ...bytes];
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

// Assembles a synthetic JWW file. Unspecified fields take defaults, and `rest`
// is the seam where the remaining header items and the entity list are appended.
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
