import type { Point } from "./geometry";
import { JwwArchiveReader, JwwParseError } from "./jww-archive-reader";

export { JwwParseError };

const SIGNATURE = "JwwData.";
const OLDEST_VERSION = 230;
// Ver.3.00 以降はヘッダに天空図の条件・マークジャンプ 8 件・文字の描画状態が入る。
// Ver.3.00 より前で読めるのは Ver.2.30 だけ（jwwdoc.cpp::ReadHeader() と同条件）。
const EXTENDED_HEADER_VERSION = 300;
// Ver.4.20 以降はヘッダに SXF 対応の拡張線色定義と拡張線種定義が入る。
const SXF_HEADER_VERSION = 420;
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

export type JwwEntity = JwwLineEntity | JwwArcEntity;

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
  return { header, entities: [], skippedCount: 0 };
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
