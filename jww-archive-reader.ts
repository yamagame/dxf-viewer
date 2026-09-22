const CP932_DECODER = new TextDecoder("shift_jis");

const NULL_OBJECT_TAG = 0x0000;
const NEW_CLASS_OBJECT_TAG = 0xffff;
const CLASS_INDEX_MASK = 0x7fff;
const STRING_LENGTH_WORD_ESCAPE = 0xff;
const STRING_LENGTH_DWORD_ESCAPE = 0xffff;
const COUNT_DWORD_ESCAPE = 0xffff;

export type JwwObjectTag =
  | { kind: "null" }
  | { kind: "new-class"; schema: number; className: string }
  | { kind: "class-ref"; classIndex: number };

export class JwwParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = "JwwParseError";
    this.offset = offset;
  }
}

export class JwwArchiveReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private cursor: number;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.cursor = 0;
  }

  get offset(): number {
    return this.cursor;
  }

  get byteLength(): number {
    return this.bytes.byteLength;
  }

  readAscii(length: number): string {
    this.ensureAvailable(length);
    let text = "";
    for (let index = 0; index < length; index += 1) {
      text += String.fromCharCode(this.bytes[this.cursor + index]);
    }
    this.cursor += length;
    return text;
  }

  readByte(): number {
    this.ensureAvailable(1);
    const value = this.view.getUint8(this.cursor);
    this.cursor += 1;
    return value;
  }

  readWord(): number {
    this.ensureAvailable(2);
    const value = this.view.getUint16(this.cursor, true);
    this.cursor += 2;
    return value;
  }

  readDword(): number {
    this.ensureAvailable(4);
    const value = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return value;
  }

  readDouble(): number {
    this.ensureAvailable(8);
    const value = this.view.getFloat64(this.cursor, true);
    this.cursor += 8;
    return value;
  }

  readString(): string {
    const start = this.cursor;
    try {
      const length = this.readStringLength();
      this.ensureAvailable(length);
      const text = CP932_DECODER.decode(
        this.bytes.subarray(this.cursor, this.cursor + length)
      );
      this.cursor += length;
      return text;
    } catch (error) {
      this.cursor = start;
      throw error;
    }
  }

  readCount(): number {
    const start = this.cursor;
    try {
      const shortCount = this.readWord();
      if (shortCount < COUNT_DWORD_ESCAPE) return shortCount;
      return this.readDword();
    } catch (error) {
      this.cursor = start;
      throw error;
    }
  }

  readObjectTag(): JwwObjectTag {
    const start = this.cursor;
    try {
      const tag = this.readWord();
      if (tag === NULL_OBJECT_TAG) {
        return { kind: "null" };
      }
      if (tag === NEW_CLASS_OBJECT_TAG) {
        const schema = this.readWord();
        const nameLength = this.readWord();
        return { kind: "new-class", schema, className: this.readAscii(nameLength) };
      }
      return { kind: "class-ref", classIndex: tag & CLASS_INDEX_MASK };
    } catch (error) {
      this.cursor = start;
      throw error;
    }
  }

  skip(byteLength: number): void {
    this.ensureAvailable(byteLength);
    this.cursor += byteLength;
  }

  private readStringLength(): number {
    const first = this.readByte();
    if (first < STRING_LENGTH_WORD_ESCAPE) return first;
    const second = this.readWord();
    if (second < STRING_LENGTH_DWORD_ESCAPE) return second;
    return this.readDword();
  }

  private ensureAvailable(byteLength: number): void {
    if (byteLength < 0 || this.cursor + byteLength > this.bytes.byteLength) {
      throw new JwwParseError(
        `バイト位置 ${this.cursor} で ${byteLength} バイトの読み取りが範囲外です`,
        this.cursor
      );
    }
  }
}
