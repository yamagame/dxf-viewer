import type { Point } from "./geometry";
import {
  JwwArchiveReader,
  JwwParseError,
  type JwwObjectTag,
} from "./jww-archive-reader";

export { JwwParseError };

const SIGNATURE = "JwwData.";
const OLDEST_VERSION = 230;
// Ver.3.00 以降はヘッダに天空図の条件・マークジャンプ 8 件・文字の描画状態が入る。
// Ver.3.00 より前で読めるのは Ver.2.30 だけ（jwwdoc.cpp::ReadHeader() と同条件）。
const EXTENDED_HEADER_VERSION = 300;
// Ver.4.20 以降はヘッダに SXF 対応の拡張線色定義と拡張線種定義が入る。
const SXF_HEADER_VERSION = 420;
// Ver.3.51 以降は図形基底クラス CData が線幅 WORD を 1 つ余分に持つ。
// ヘッダではなく図形側の分岐（jwwdoc.h CData::Serialize の nOldVersionSave >= 351）。
const PEN_WIDTH_VERSION = 351;
const LINE_CLASS_NAME = "CDataSen";
const ARC_CLASS_NAME = "CDataEnko";
const POINT_CLASS_NAME = "CDataTen";
const TEXT_CLASS_NAME = "CDataMoji";
const DIMENSION_CLASS_NAME = "CDataSunpou";
const SOLID_CLASS_NAME = "CDataSolid";
const BLOCK_REFERENCE_CLASS_NAME = "CDataBlock";
// 点は線種番号が 100 のときだけ点コード・回転角・倍率を持つ。
const POINT_CODE_PEN_STYLE = 100;
// ソリッドは線色番号が 10 のときだけ任意色の RGB 値を持つ。
const ARBITRARY_COLOR_PEN_COLOR = 10;
// Ver.4.20 以降の寸法は SXF モードと補助線 2・点 4 のメンバが付く。
const SXF_DIMENSION_VERSION = 420;
// クラス参照のオブジェクトタグは WORD 1 つ。図形 1 件はこれと CData 基底を
// 必ず伴うので、要素数の妥当性を測る最小バイト数になる。
const OBJECT_TAG_BYTES = 2;
// MFC の読み込み配列はインデックス 0 を NULL タグ用に予約する。
const FIRST_LOAD_ARRAY_INDEX = 1;
const LAYER_GROUP_COUNT = 16;
const LAYER_COUNT = 16;
const MAX_LAYER_STATE = 3;
const EXTENDED_COLOR_COUNT = 257;
const EXTENDED_LINE_TYPE_COUNT = 33;

export type JwwLayerAddress = { group: number; layer: number };

export type JwwLayerState = 0 | 1 | 2 | 3;

export type JwwLayer = { state: JwwLayerState; name: string };

export type JwwLayerGroup = {
  state: JwwLayerState;
  scale: number;
  name: string;
  layers: JwwLayer[];
};

export type JwwHeader = {
  version: number;
  memo: string;
  groups: JwwLayerGroup[];
};

export type JwwLineEntity = {
  type: "line";
  address: JwwLayerAddress;
  from: Point;
  to: Point;
};

export type JwwArcEntity = {
  type: "arc";
  address: JwwLayerAddress;
  center: Point;
  radius: number;
  startAngle: number;
  sweepAngle: number;
  tiltAngle: number;
  flatness: number;
  fullCircle: boolean;
};

export type JwwTextEntity = { type: "text"; address: JwwLayerAddress; position: Point; text: string; height: number; rotation: number };
export type JwwEntity = JwwLineEntity | JwwArcEntity | JwwTextEntity;

export type JwwDocument = {
  header: JwwHeader;
  entities: JwwEntity[];
  skippedCount: number;
};

export function isJwwSignature(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < SIGNATURE.length) return false;
  const head = new Uint8Array(buffer, 0, SIGNATURE.length);
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (head[index] !== SIGNATURE.charCodeAt(index)) return false;
  }
  return true;
}

export function parseJww(buffer: ArrayBuffer): JwwDocument {
  if (!isJwwSignature(buffer)) {
    throw new JwwParseError(`JWW の署名 "${SIGNATURE}" が先頭にありません`, 0);
  }
  const archive = new JwwArchiveReader(buffer);
  archive.skip(SIGNATURE.length);
  const header = readHeader(archive);
  const { entities, skippedCount } = readEntities(archive, header.version);
  return { header, entities, skippedCount };
}

// ヘッダ項目の順序とバージョン分岐は jwdatafmt.txt（Jw_cad データ形式解説）と
// jwwdoc.cpp::ReadHeader() に従う。走査が 1 項目でもずれると図形リストの開始位置が
// ずれるため、読み飛ばす項目も型と件数を明示して消費する。
function readHeader(archive: JwwArchiveReader): JwwHeader {
  const version = readVersion(archive);
  const memo = archive.readString();
  archive.readDword(); // 図面サイズ
  archive.readDword(); // 書込レイヤグループ
  const groups = readLayerGroups(archive);
  skipSettingsBeforeLayerNames(archive);
  readLayerNames(archive, groups);
  readLayerGroupNames(archive, groups);
  skipSettingsAfterLayerNames(archive, version);
  return { version, memo, groups };
}

function readVersion(archive: JwwArchiveReader): number {
  const offset = archive.offset;
  const version = archive.readDword();
  if (version !== OLDEST_VERSION && version < EXTENDED_HEADER_VERSION) {
    throw new JwwParseError(
      `データバージョン ${version} は JWW として読み取れません`,
      offset
    );
  }
  return version;
}

function readLayerGroups(archive: JwwArchiveReader): JwwLayerGroup[] {
  const groups: JwwLayerGroup[] = [];
  for (let index = 0; index < LAYER_GROUP_COUNT; index += 1) {
    groups.push(readLayerGroup(archive));
  }
  return groups;
}

function readLayerGroup(archive: JwwArchiveReader): JwwLayerGroup {
  const state = readState(archive, "レイヤグループ状態");
  archive.readDword(); // 書込レイヤ
  const scale = archive.readDouble();
  archive.readDword(); // プロテクト指定
  const layers: JwwLayer[] = [];
  for (let index = 0; index < LAYER_COUNT; index += 1) {
    layers.push(readLayer(archive));
  }
  return { state, scale, name: "", layers };
}

function readLayer(archive: JwwArchiveReader): JwwLayer {
  const state = readState(archive, "レイヤ状態");
  archive.readDword(); // プロテクト指定
  return { state, name: "" };
}

function readLayerNames(
  archive: JwwArchiveReader,
  groups: JwwLayerGroup[]
): void {
  for (const group of groups) {
    for (const layer of group.layers) {
      layer.name = archive.readString();
    }
  }
}

function readLayerGroupNames(
  archive: JwwArchiveReader,
  groups: JwwLayerGroup[]
): void {
  for (const group of groups) {
    group.name = archive.readString();
  }
}

// レイヤ状態ブロックの直後からレイヤ名の直前まで。
function skipSettingsBeforeLayerNames(archive: JwwArchiveReader): void {
  skipDwords(archive, 14); // ダミー
  skipDwords(archive, 5); // 寸法関係の設定
  skipDwords(archive, 1); // ダミー
  skipDwords(archive, 1); // 線描画の最大幅
  skipDoubles(archive, 3); // プリンタ出力範囲の原点 x, y と出力倍率
  skipDwords(archive, 2); // プリンタ 90 度回転出力、目盛設定モード
  skipDoubles(archive, 5); // 目盛の表示最小間隔、表示間隔 x, y、基準点 x, y
}

// レイヤグループ名の直後から図形データリストの直前まで。
function skipSettingsAfterLayerNames(
  archive: JwwArchiveReader,
  version: number
): void {
  skipDoubles(archive, 2); // 日影計算の測定面高さ、緯度
  skipDwords(archive, 1); // 日影計算の 9〜15 時の測定指定
  skipDoubles(archive, 1); // 壁面日影の測定面高さ
  if (version >= EXTENDED_HEADER_VERSION) {
    skipDoubles(archive, 2); // 天空図の測定面高さ、半径
  }
  skipDwords(archive, 1); // 2.5D の計算単位
  skipDoubles(archive, 6); // 保存時の画面倍率と原点、範囲記憶の倍率と基準点
  skipMarkJumps(archive, version);
  if (version >= EXTENDED_HEADER_VERSION) {
    skipTextDrawState(archive);
  }
  skipDoubles(archive, 11); // 複線間隔 10 件と両側複線の留線出寸法
  skipPenSettings(archive);
  skipLineTypeSettings(archive);
  skipPrintAndViewpointSettings(archive);
  if (version >= SXF_HEADER_VERSION) {
    skipExtendedColors(archive);
    skipExtendedLineTypes(archive);
  }
  skipTextSettings(archive);
}

// マークジャンプの倍率と基準点。Ver.3.00 以降は 8 件で所属レイヤグループが付く。
function skipMarkJumps(archive: JwwArchiveReader, version: number): void {
  if (version >= EXTENDED_HEADER_VERSION) {
    for (let index = 0; index < 8; index += 1) {
      skipDoubles(archive, 3);
      skipDwords(archive, 1);
    }
    return;
  }
  for (let index = 0; index < 4; index += 1) {
    skipDoubles(archive, 3);
  }
}

// 文字の描画状態（Ver.4.04 以前はダミー）。
function skipTextDrawState(archive: JwwArchiveReader): void {
  skipDoubles(archive, 3);
  skipDwords(archive, 1);
  skipDoubles(archive, 3);
  skipDwords(archive, 1);
}

function skipPenSettings(archive: JwwArchiveReader): void {
  skipDwords(archive, 20); // 色番号 0〜9 の画面表示色と線幅
  for (let index = 0; index < 10; index += 1) {
    skipDwords(archive, 2); // プリンタ出力色と線幅
    skipDoubles(archive, 1); // 実点半径
  }
}

function skipLineTypeSettings(archive: JwwArchiveReader): void {
  skipDwords(archive, 32); // 線種番号 2〜9
  skipDwords(archive, 25); // ランダム線 1〜5
  skipDwords(archive, 16); // 倍長線種番号 6〜9
}

function skipPrintAndViewpointSettings(archive: JwwArchiveReader): void {
  skipDwords(archive, 16); // 描画・印刷の指定 12 件、2.5D 視点フラグ、視点水平角 3 件
  skipDoubles(archive, 5); // 2.5D の透視図・鳥瞰図・アイソメ図の視点
  skipDoubles(archive, 4); // 線の長さ、矩形寸法 x, y、円の半径の最終値
  skipDwords(archive, 2); // ソリッドの任意色フラグと既定色
}

// SXF 対応拡張線色定義（Ver.4.20 以降）。
function skipExtendedColors(archive: JwwArchiveReader): void {
  skipDwords(archive, 2 * EXTENDED_COLOR_COUNT); // 画面表示色と線幅
  for (let index = 0; index < EXTENDED_COLOR_COUNT; index += 1) {
    archive.readString(); // 線色名
    skipDwords(archive, 2); // プリンタ出力色と線幅
    skipDoubles(archive, 1); // 実点半径
  }
}

// SXF 対応拡張線種定義（Ver.4.20 以降）。
function skipExtendedLineTypes(archive: JwwArchiveReader): void {
  skipDwords(archive, 4 * EXTENDED_LINE_TYPE_COUNT); // 線種パターン
  for (let index = 0; index < EXTENDED_LINE_TYPE_COUNT; index += 1) {
    archive.readString(); // 線種名
    skipDwords(archive, 1); // セグメント数
    skipDoubles(archive, 10); // ピッチ線分の長さと空白長さ
  }
}

// 文字種設定と文字基準点設定。ヘッダはここで終わり、次が図形データリストの要素数。
function skipTextSettings(archive: JwwArchiveReader): void {
  for (let index = 0; index < 10; index += 1) {
    skipDoubles(archive, 3); // 文字種 1〜10 の文字幅、高さ、間隔
    skipDwords(archive, 1); // 色番号
  }
  skipDoubles(archive, 3); // 書込み文字の文字幅、高さ、間隔
  skipDwords(archive, 2); // 書込み文字の色番号、文字番号
  skipDoubles(archive, 2); // 文字位置整理の行間、文字数
  skipDwords(archive, 1); // 文字基準点のずれ位置使用フラグ
  skipDoubles(archive, 6); // 文字基準点の横方向と縦方向のずれ位置
}

type JwwEntityList = { entities: JwwEntity[]; skippedCount: number };

// 図形データリスト（m_DataList）。要素数 → オブジェクトタグ → クラス別フィールド
// の順に並ぶ。ブロック定義リスト（m_DataListList）はこの直後だが読まない。
function readEntities(
  archive: JwwArchiveReader,
  version: number
): JwwEntityList {
  const count = readEntityCount(archive, version);
  const classNames = new Map<number, string>();
  let nextLoadIndex = FIRST_LOAD_ARRAY_INDEX;
  const entities: JwwEntity[] = [];
  let skippedCount = 0;
  for (let index = 0; index < count; index += 1) {
    const offset = archive.offset;
    const tag = archive.readObjectTag();
    const className = resolveClassName(tag, classNames, offset);
    if (tag.kind === "new-class") {
      classNames.set(nextLoadIndex, className);
      nextLoadIndex += 1;
    }
    // クラスに続く実体も読み込み配列の 1 枠を占める（MFC CArchive::ReadObject）。
    nextLoadIndex += 1;
    const entity = readEntity(archive, version, className, offset);
    if (entity === null) {
      skippedCount += 1;
      continue;
    }
    entities.push(entity);
  }
  return { entities, skippedCount };
}

// 要素数はヘッダ誤読を検出する最初の関門。1 件あたり最低でもオブジェクトタグと
// CData 基底が要るため、残りバイト数で賄えない件数はその場で失敗させる。
function readEntityCount(
  archive: JwwArchiveReader,
  version: number
): number {
  const offset = archive.offset;
  const count = archive.readCount();
  const remaining = archive.byteLength - archive.offset;
  const minimumBytes = OBJECT_TAG_BYTES + entityBaseByteLength(version);
  if (count * minimumBytes > remaining) {
    throw new JwwParseError(
      `図形データリストの要素数 ${count} は残り ${remaining} バイトに収まりません`,
      offset
    );
  }
  return count;
}

// 初出のクラス名を読み込み配列の番号で記録し、以降のタグ参照はその番号で引く。
function resolveClassName(
  tag: JwwObjectTag,
  classNames: Map<number, string>,
  offset: number
): string {
  if (tag.kind === "new-class") return tag.className;
  if (tag.kind === "null") {
    throw new JwwParseError("図形データリストのタグが空です", offset);
  }
  const className = classNames.get(tag.classIndex);
  if (className === undefined) {
    throw new JwwParseError(
      `クラス参照 ${tag.classIndex} に対応する図形クラスがありません`,
      offset
    );
  }
  return className;
}

// 7 つの図形クラスはいずれも CData を先頭に持つので、基底を読んでから分岐する。
// 線と円弧だけを返し、残りはフィールドを消費して null を返す。図形リストは長さを
// 前置きしないため、消費するクラスも 1 バイトの過不足なく歩く必要がある。
type JwwEntityReader = (
  archive: JwwArchiveReader,
  version: number,
  base: JwwEntityBase
) => JwwEntity | null;

const ENTITY_READERS = new Map<string, JwwEntityReader>([
  [LINE_CLASS_NAME, (archive, _version, base) => readLine(archive, base)],
  [ARC_CLASS_NAME, (archive, _version, base) => readArc(archive, base)],
  [
    POINT_CLASS_NAME,
    (archive, _version, base) => {
      consumePoint(archive, base);
      return null;
    },
  ],
  [
    TEXT_CLASS_NAME,
    (archive, _version, base) => readText(archive, base),
  ],
  [
    DIMENSION_CLASS_NAME,
    (archive, version) => {
      consumeDimension(archive, version);
      return null;
    },
  ],
  [
    SOLID_CLASS_NAME,
    (archive, _version, base) => {
      consumeSolid(archive, base);
      return null;
    },
  ],
  [
    BLOCK_REFERENCE_CLASS_NAME,
    (archive) => {
      consumeBlockReference(archive);
      return null;
    },
  ],
]);

function readEntity(
  archive: JwwArchiveReader,
  version: number,
  className: string,
  offset: number
): JwwEntity | null {
  const read = ENTITY_READERS.get(className);
  if (read === undefined) {
    throw new JwwParseError(`図形クラス ${className} は読み取れません`, offset);
  }
  const base = readEntityBase(archive, version);
  return read(archive, version, base);
}

// 図形データの基底クラス CData（jwdatafmt.txt / jwwdoc.h CData::Serialize）。
// 線種番号と線色番号は点とソリッドの条件付きフィールドを左右するため保持する。
type JwwEntityBase = {
  address: JwwLayerAddress;
  penStyle: number;
  penColor: number;
};

function readEntityBase(
  archive: JwwArchiveReader,
  version: number
): JwwEntityBase {
  archive.readDword(); // 曲線属性番号
  const penStyle = archive.readByte(); // 線種番号
  const penColor = archive.readWord(); // 線色番号
  if (version >= PEN_WIDTH_VERSION) {
    archive.readWord(); // 線幅
  }
  const layer = archive.readWord();
  const group = archive.readWord();
  archive.readWord(); // 属性フラグ
  return { address: { group, layer }, penStyle, penColor };
}

// CData 基底の実バイト数。Ver.3.51 以降は線幅 WORD が 1 つ増えて 15 バイト。
function entityBaseByteLength(version: number): number {
  return version >= PEN_WIDTH_VERSION ? 15 : 13;
}

function readLine(
  archive: JwwArchiveReader,
  base: JwwEntityBase
): JwwLineEntity {
  const from = readPoint(archive);
  const to = readPoint(archive);
  return { type: "line", address: base.address, from, to };
}

// 角度はラジアン、座標と半径はファイル内の値をそのまま持つ（換算しない）。
function readArc(
  archive: JwwArchiveReader,
  base: JwwEntityBase
): JwwArcEntity {
  const center = readPoint(archive);
  const radius = archive.readDouble();
  const startAngle = archive.readDouble();
  const sweepAngle = archive.readDouble();
  const tiltAngle = archive.readDouble();
  const flatness = archive.readDouble();
  const fullCircle = archive.readDword() !== 0;
  return {
    type: "arc",
    address: base.address,
    center,
    radius,
    startAngle,
    sweepAngle,
    tiltAngle,
    flatness,
    fullCircle,
  };
}

function readPoint(archive: JwwArchiveReader): Point {
  const x = archive.readDouble();
  const y = archive.readDouble();
  return { x, y };
}

// 点データ CDataTen。線種番号が 100 のときだけ点コード以降が続く。
function consumePoint(archive: JwwArchiveReader, base: JwwEntityBase): void {
  skipDoubles(archive, 2); // 点 x, y
  skipDwords(archive, 1); // 仮点フラグ
  if (base.penStyle !== POINT_CODE_PEN_STYLE) return;
  skipDwords(archive, 1); // 点コード
  skipDoubles(archive, 2); // 表示角、表示倍率
}

// 文字データ CDataMoji。末尾はフォント名と文字列の CString 2 つ。
function readText(archive: JwwArchiveReader, base: JwwEntityBase): JwwTextEntity {
  const position = readPoint(archive);
  readPoint(archive);
  archive.readDword();
  const width = archive.readDouble();
  const height = archive.readDouble();
  archive.readDouble();
  const rotation = archive.readDouble();
  archive.readString();
  const text = archive.readString();
  return { type: "text", address: base.address, position, text, height: Math.abs(height || width), rotation };
}

function consumeText(archive: JwwArchiveReader): void {
  skipDoubles(archive, 4);
  skipDwords(archive, 1);
  skipDoubles(archive, 4);
  archive.readString();
  archive.readString();
}

// 寸法データ CDataSunpou。線・文字・点のメンバはそれぞれ CData 基底から始まる。
function consumeDimension(archive: JwwArchiveReader, version: number): void {
  consumeMemberLine(archive, version); // 線分メンバ
  consumeMemberText(archive, version); // 文字メンバ
  if (version < SXF_DIMENSION_VERSION) return;
  archive.readWord(); // SXF のモード
  consumeMemberLine(archive, version); // 補助線 1
  consumeMemberLine(archive, version); // 補助線 2
  consumeMemberPoint(archive, version); // 矢印 1
  consumeMemberPoint(archive, version); // 矢印 2
  consumeMemberPoint(archive, version); // 基準点 1
  consumeMemberPoint(archive, version); // 基準点 2
}

function consumeMemberLine(archive: JwwArchiveReader, version: number): void {
  readEntityBase(archive, version);
  skipDoubles(archive, 4); // 始点 x, y と終点 x, y
}

function consumeMemberText(archive: JwwArchiveReader, version: number): void {
  readEntityBase(archive, version);
  consumeText(archive);
}

function consumeMemberPoint(archive: JwwArchiveReader, version: number): void {
  consumePoint(archive, readEntityBase(archive, version));
}

// ソリッドデータ CDataSolid。線色番号が 10 のときだけ RGB 値が続く。
function consumeSolid(archive: JwwArchiveReader, base: JwwEntityBase): void {
  skipDoubles(archive, 8); // 第 1〜4 点の x, y
  if (base.penColor !== ARBITRARY_COLOR_PEN_COLOR) return;
  skipDwords(archive, 1); // 塗潰し色の RGB 値
}

// ブロック参照 CDataBlock。参照先のブロック定義リストは読まない。
function consumeBlockReference(archive: JwwArchiveReader): void {
  skipDoubles(archive, 5); // 基準点 x, y、倍率 x, y、回転角
  skipDwords(archive, 1); // ブロック定義データの通し番号
}

function skipDwords(archive: JwwArchiveReader, count: number): void {
  archive.skip(count * 4);
}

function skipDoubles(archive: JwwArchiveReader, count: number): void {
  archive.skip(count * 8);
}

function readState(archive: JwwArchiveReader, label: string): JwwLayerState {
  const offset = archive.offset;
  const value = archive.readDword();
  if (value > MAX_LAYER_STATE) {
    throw new JwwParseError(
      `${label} の値 ${value} は 0〜${MAX_LAYER_STATE} の範囲外です`,
      offset
    );
  }
  return value as JwwLayerState;
}
