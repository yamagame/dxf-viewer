# Requirements Document

## Introduction

本機能は、DXF Viewer に JWW（JW_cad 形式）ファイルの読み込みを追加する。手持ちの図面資産が JWW 中心である利用者は、現在この閲覧ツールで図面を開くために JW_cad などで DXF へ変換する必要があり、変換環境がない場面では図面を一切確認できない。

追加後は、既存のファイル選択から JWW をそのまま選び、拡張子で処理を振り分けて描画できる。JWW で読み込む図形は現在 DXF で対応している範囲（線・円・円弧）に揃え、読み込み後はビュー操作・頂点/交点スナップによる距離測定・エッジ選択・レイヤー表示切替という既存機能がそのまま使える状態を目標とする。

## Boundary Context

- **In scope**: `.jww` ファイルの選択と形式判定、線・真円・円弧の描画、JWW のレイヤグループ／レイヤに対応したレイヤー表示切替（ファイル内の表示状態の反映を含む）、読み込み後の既存機能（ビュー操作・距離測定・交点スナップ・エッジ選択）の動作、読み込み状況とエラーの表示。
- **Out of scope**: 文字要素・寸法要素・ソリッド（塗りつぶし）・ブロック（図形）の展開、楕円および扁平率を持つ円弧の描画、レイヤグループの縮尺を反映した実寸換算、JWW の編集・保存・書き出し、DXF ⇔ JWW の相互変換、線種・線色・線幅の再現。
- **Adjacent expectations**: 既存の DXF 読み込み経路の利用者から見た挙動は変えない。距離測定・エッジ選択・レイヤー表示切替の操作方法と表示書式は既存のものに従い、本機能はそれらへ渡すデータを JWW からも供給することだけを担う。JWW を解析する手段（自前実装か既存ライブラリか）は本書では決めず、設計フェーズで判断する。

## Requirements

### Requirement 1: JWW ファイルの選択と形式判定

**Objective:** As a 手持ち図面が JWW 中心の閲覧者, I want 既存のファイル選択から JWW ファイルをそのまま選べること, so that DXF へ変換する手間と環境なしに図面を開ける

#### Acceptance Criteria

1. The DXF Viewer shall ファイル選択コントロールで `.dxf` と `.jww` の両方を選択候補として提示する
2. When 利用者が拡張子 `.jww` のファイルを選択した時, the DXF Viewer shall そのファイルを JWW として解析し、図面表示領域に描画する
3. When 利用者が拡張子 `.dxf` のファイルを選択した時, the DXF Viewer shall 従来どおり DXF として解析し、本機能の追加前と同じ表示結果を得る
4. The DXF Viewer shall 拡張子の判定で大文字・小文字を区別しない
5. If 選択されたファイルの拡張子が `.dxf` / `.jww` のいずれでもない時, then the DXF Viewer shall 解析を行わず、対応形式ではない旨のメッセージを表示する

### Requirement 2: JWW 図形の描画

**Objective:** As a 図面を確認したい閲覧者, I want JWW の基本図形が DXF と同じ見え方で描画されること, so that 形式を意識せずに図面の内容を読み取れる

#### Acceptance Criteria

1. When JWW ファイルの解析が成功した時, the DXF Viewer shall JWW の線要素を線分として描画する
2. When JWW ファイルの解析が成功した時, the DXF Viewer shall JWW の真円要素を円として、円弧要素を円弧として、それぞれ元の位置・半径・角度範囲どおりに描画する
3. If JWW ファイルに扁平率を持つ円弧（楕円・楕円弧）が含まれる時, then the DXF Viewer shall その要素を描画対象から除外し、残りの図形の描画を継続する
4. If JWW ファイルに文字・寸法・ソリッド・ブロックなど対応対象外の要素が含まれる時, then the DXF Viewer shall それらを描画対象から除外し、残りの図形の描画を継続する
5. If 描画対象の図形を 1 つも抽出できなかった時, then the DXF Viewer shall 対応要素が見つからなかった旨のメッセージを表示する
6. When JWW の読み込みが成功した時, the DXF Viewer shall 描画した図形全体が図面表示領域に収まる初期表示にする
7. The DXF Viewer shall JWW の座標値を縮尺換算せず、ファイル内の値をそのままモデル座標として扱う

### Requirement 3: JWW のレイヤー表示切替

**Objective:** As a レイヤーで図面を読み解く閲覧者, I want JWW のレイヤグループとレイヤを単位に表示/非表示を切り替えられること, so that 必要な情報だけを残して図面を確認できる

#### Acceptance Criteria

1. When JWW の読み込みが成功した時, the DXF Viewer shall 図形が存在するレイヤグループとレイヤの組み合わせだけを、両者を連結した 1 つの名前としてレイヤー一覧に表示する
2. If レイヤグループ名またはレイヤ名がファイル内で未設定の時, then the DXF Viewer shall その番号にもとづく既定名を用いて一覧の項目名を構成する
3. When ファイル内でレイヤが非表示として保存されていた時, the DXF Viewer shall 読み込み直後のそのレイヤを非表示状態として一覧に表示する
4. While レイヤが非表示の時, the DXF Viewer shall そのレイヤの図形を描画せず、距離測定の頂点・交点およびエッジ選択の対象にも含めない
5. When 利用者が非表示のレイヤを表示に切り替えた時, the DXF Viewer shall そのレイヤの図形を描画し、距離測定とエッジ選択の対象に加える
6. The DXF Viewer shall 日本語を含むレイヤグループ名・レイヤ名を文字化けなく表示する
7. If ファイル内のすべてのレイヤが非表示として保存されていた時, then the DXF Viewer shall 図形を描画しない状態でレイヤー一覧を表示し、利用者が表示へ切り替えられるようにする

### Requirement 4: 読み込み後の閲覧・計測機能の継続

**Objective:** As a 図面上の寸法を確認したい閲覧者, I want JWW でも DXF と同じ操作で計測・選択できること, so that 形式ごとに操作を覚え直さずに済む

#### Acceptance Criteria

1. When JWW の読み込みが成功した時, the DXF Viewer shall 全体表示・拡大・縮小・パンを DXF 読み込み時と同じ操作方法で提供する
2. When 利用者が表示中の JWW 図形の頂点を 2 つ選択した時, the DXF Viewer shall 2 点間の距離と ΔX / ΔY を DXF 読み込み時と同じ書式で表示する
3. The DXF Viewer shall 表示中の線分同士の交点を、JWW 図面でも測定対象の頂点として選択できるようにする
4. When 利用者が JWW 図形のエッジをクリックした時, the DXF Viewer shall そのエッジを選択状態にし、レイヤー一覧と同じ項目名で所属レイヤーを表示する
5. The DXF Viewer shall JWW の円・円弧を、DXF の場合と同じく距離測定とエッジ選択の対象に含めない
6. When 新しいファイルが読み込まれた時, the DXF Viewer shall 直前の図面の測定結果・エッジ選択・レイヤー表示設定を破棄する

### Requirement 5: 読み込み状況の表示とエラー処理

**Objective:** As a ファイルを読み込む利用者, I want 読み込みの進行と失敗理由が画面で分かること, so that 開けない原因を判断して次の行動を取れる

#### Acceptance Criteria

1. When ファイルの読み込みを開始した時, the DXF Viewer shall 読み込み中である旨と対象のファイル名を表示する
2. When JWW の読み込みと描画が完了した時, the DXF Viewer shall ファイル名・描画した要素数・レイヤー数を表示する
3. If JWW ファイルの解析に失敗した時, then the DXF Viewer shall JWW の解析に失敗した旨とファイル形式の確認を促すメッセージを表示する
4. If 拡張子が `.jww` でも内容が JWW 形式として読み取れない時, then the DXF Viewer shall 解析失敗と同じ扱いでメッセージを表示する
5. If 読み込みに失敗した時, then the DXF Viewer shall 図面表示領域を空にし、拡大・縮小・全体表示の各操作を無効状態に戻す
6. The DXF Viewer shall 選択された JWW ファイルの内容を外部へ送信せず、ブラウザ内での処理だけで描画を完了する
