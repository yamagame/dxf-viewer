import type { Point } from "./geometry";
import { JwwArchiveReader, JwwParseError } from "./jww-archive-reader";

export { JwwParseError };

const SIGNATURE = "JwwData.";
const OLDEST_VERSION = 230;
const OLDEST_BRANCHED_VERSION = 300;
const LAYER_GROUP_COUNT = 16;
const LAYER_COUNT = 16;
const MAX_LAYER_STATE = 3;

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

function readHeader(archive: JwwArchiveReader): JwwHeader {
  const version = readVersion(archive);
  const memo = archive.readString();
  archive.readDword(); // 図面サイズ
  archive.readDword(); // 書込レイヤグループ
  const groups = readLayerGroups(archive);
  return { version, memo, groups };
}

function readVersion(archive: JwwArchiveReader): number {
  const offset = archive.offset;
  const version = archive.readDword();
  if (version !== OLDEST_VERSION && version < OLDEST_BRANCHED_VERSION) {
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
