# Maestro

[English](./README.md) · [简体中文](./README.zh-CN.md) · **日本語**

> あなたのためのクロスプラットフォーム「音楽脳」。NetEase Cloud Music、
> QQ Music、Spotify、Deezer にログインし、**各プラットフォームでいいね
> （♥）した曲**をすべて集約。大規模言語モデル（**DeepSeek**、あなた
> **自身**の API キーを使用）が次に好きになりそうな曲を提案します。そして
> ♥ を押したら、**権利のあるすべてのプラットフォームに一括で ♥ を付与**。
> 「お住まいの地域では利用できません／権利がありません」で音楽が止まること
> は、もうありません。

**Electron + React + NestJS** によるデスクトップファーストのクライアント。

> ⚠️ **ステータス：Phase 0–5 完了、Phase 6（フロントエンド再構成 + パッケージング）
> を出荷中。** 4 つのプラットフォームアダプター、統合検索、クロスプラット
> フォーム照合エンジン、統合ライブラリ、DeepSeek レコメンド、♥ 一括付与、
> visionOS 風 Bento グラス UI、Spotify OAuth PKCE + ♥ 書き戻し、Premium
> フル尺再生（Web Playback SDK + Widevine、castLabs Electron fork で動作）
> が dev で動作中。残作業（VMP 署名付き本番パッケージング、Settings /
> Lite モード UX、デスクトップ細部）は
> [next-iteration plan](./NEXT-ITERATION.md) を参照。

---

## コンセプト

各ストリーミングサービスは、あなたの好みの一部と、世界のカタログの一部しか
持っておらず、そのどちらも完全ではありません。QQ Music で大好きな曲が
NetEase には無い。Spotify のおすすめがあなたの地域では権利を持たない。
Maestro は、この 4 つのプラットフォームを**あなた自身が所有する 1 つの
ライブラリ**として扱います。

```
   ┌── 接続 ────────────────────────────────────────────────┐
   │  NetEase · QQ Music · Spotify · Deezer                  │
   └───────────────┬────────────────────────────────────────┘
                   │  各プラットフォームから「いいね（♥）」曲を取得
                   ▼
   ┌── 集約 ────────────────────────────────────────────────┐
   │  統合・重複排除した「好きな曲」ライブラリを 1 つに      │
   └───────────────┬────────────────────────────────────────┘
                   │  DeepSeek に送信（あなたの API キー）
                   ▼
   ┌── レコメンド ──────────────────────────────────────────┐
   │  LLM が次に好きになりそうな曲を提案                     │
   └───────────────┬────────────────────────────────────────┘
                   │  あなたが ♥ を押す
                   ▼
   ┌── どこでも ♥ ──────────────────────────────────────────┐
   │  権利のあるすべてのプラットフォームに ♥ を付与         │
   └───────────────┬────────────────────────────────────────┘
                   │  再生
                   ▼
   ┌── 行き止まりなし ──────────────────────────────────────┐
   │  全プラットフォームを同時に検索し、実際に権利を持つ    │
   │  ものから再生 → 「利用不可」の断絶が起きない           │
   └────────────────────────────────────────────────────────┘
```

### 設計方針

- **デスクトップクライアント優先。** すべての認証情報と DeepSeek API キーは
  **ローカル**に保存され、Maestro のサーバー（そもそも存在しません）に送信
  されることはありません。
- **集約データはあなたのもの。** 各プラットフォームのいいね曲が、あなただけ
  が持つ単一のライブラリになります。
- **AI キーは持ち込み式。** レコメンドはあなたが用意した DeepSeek キーで実行。
  コストとデータはあなたが管理します。
- **常に著作権を考慮。** ♥ は権利のあるプラットフォームにのみ展開され、再生と
  検索は実際にその曲を提供できるプラットフォームへ自動でフォールバックします。

---

## ステータスと進捗

凡例：✅ 完了 · 🚧 一部／進行中 · 📋 予定

### プラットフォーム別の機能

| 機能                         | NetEase | QQ Music | Spotify | Deezer |
| ---------------------------- | :-----: | :------: | :-----: | :----: |
| ログイン                     | ✅ QR スキャン | ✅ cookie（埋め込みウィンドウ） | ✅ OAuth PKCE | ✅ 匿名（ログイン不要） |
| フル尺再生                   | ✅ | ✅（標準 / 320 / ロスレス） | ✅ Premium · 🚧 Free = 30 秒プレビュー | 🚧 30 秒プレビューのみ |
| ラジオ／レコメンド配信       | ✅ パーソナル FM | 🚧 キーワード擬似ラジオ | 🚧 短いプレビュー | ✅ 編集チャート |
| 検索                         | ✅ | ✅ | 🚧 制限あり | ✅ |
| ローカルいいね／興味なし     | ✅ | ✅ | ✅ | ✅ |
| ♥ をプラットフォームへ反映   | ✅ | ✅ | ✅ | ✅ |
| 既存のいいね曲をインポート   | ✅ | ✅ | ✅ | ✅ |

### 横断的なプロダクト機能

| 機能                                            | 状態 |
| ----------------------------------------------- | :--: |
| マルチソースプレーヤー基盤（Electron/React/Nest）| ✅ |
| プラットフォーム別ログインとセッション永続化    | ✅ |
| サーバーサイド音声プロキシ（実 URL は UI に出さない）| ✅ |
| visionOS 風 Bento グラス UI（カバー駆動アクセント、低音リアクティブ呼吸、歌詞パネル）| ✅ |
| ライト / ダーク / システムテーマ                | ✅ |
| **統合マルチソース検索と再生フォールバック**    | ✅ |
| **クロスプラットフォーム曲照合**（ISRC + タイトル/アーティスト/尺 あいまい）| ✅ |
| **統合いいね曲ライブラリ**（インポート + 重複排除） | ✅ |
| **DeepSeek BYO キー AI レコメンド**             | ✅ |
| **権利のある全プラットフォームへの ♥ 一括付与** | ✅ |
| **Spotify アダプター**（OAuth PKCE + 読み取り + ♥ 書き戻し + WPS フル尺 Premium）| ✅ |
| フロントエンド構成：CSS/tsx 分離 + SCSS 7-1 + 巨巨石分割 | ✅ (PR #13) |
| **castLabs Electron fork**（Widevine CDM + VMP 署名、Spotify WPS 用）| ✅ (PR #39) |
| **本番パッケージング**（NestJS サイドカー + prod API ベース + EVS VMP 署名）| 🚧 作業中 |

**おおよその完成度：約 90%。** 本プロダクトを定義づける中核機能（統合
検索・照合・ライブラリ・DeepSeek・♥ 一括付与・Spotify フル尺再生）は
エンドツーエンドで動作します。残りはパッケージングの仕上げと UX 細部
——[NEXT-ITERATION.md](./NEXT-ITERATION.md) を参照。

---

## アーキテクチャ

```
┌──────────────────────────────────────────────────────────────┐
│  レンダラー Renderer (React + Vite, :5173)                   │
│   - /api/* を呼び出し（Vite が NestJS へ開発プロキシ、       │
│     /api を除去）                                            │
│   - <audio> src = /music/stream/{provider}/{id}             │
│   - ジャケット配色抽出、テーマ、ソース切替                    │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTP（cookie セッション）
┌───────────────────────────────▼──────────────────────────────┐
│  NestJS サーバー (:3200)                                      │
│   common/   Config · Storage · Session                        │
│   auth/     QQ cookie ログイン · NetEase QR ログイン          │
│   music/    プロバイダー別ストラテジー + 音声プロキシ        │
│                                                               │
│   📋 予定：library/（いいね集約）· reco/（DeepSeek）        │
│           · match/（クロスプラットフォーム曲照合）           │
└───────────────────────────────┬──────────────────────────────┘
                                │ HTTPS（各プラットフォーム認証情報付き）
       ┌──────────────┬─────────┴──────────┬──────────────┐
       ▼              ▼                     ▼              ▼
  music.163.com   y.qq.com            Spotify Web API  api.deezer.com
  （平文 /api）   （検索 + GetVkey）    📋 予定         （公開 API）
```

**Electron メインプロセス**はさらに、埋め込みログインウィンドウ（実際の
Chromium セッションで QQ Music のログイン cookie を取得）と内部プロキシの
足場を持ちます。セッションといいね／興味なしの状態は
`packages/server/.storage/state.json`（git 管理外）に永続化されます。

---

## プロジェクト構成

```
packages/
  electron/   Electron メインプロセス —— ウィンドウ + 埋め込みログイン取得
    src/main.ts, src/preload.ts
  renderer/   React フロントエンド（UI、プレーヤー、ソース切替、検索、QR モーダル）
    src/App.tsx, api.ts, SourceSelect.tsx, SearchPanel.tsx, NeteaseCookieModal.tsx
  server/     NestJS バックエンド
    src/common/   config · storage · session · provider レジストリ
    src/auth/     auth.controller · qq.strategy · netease-auth.strategy
    src/music/    music.controller · music.service
                  qq.provider · netease.provider · deezer.provider
                  netease-crypto（weapi AES/RSA —— レガシー、備考参照）
```

---

## セットアップ

```bash
# Node 18+ が必要（Node 22 推奨）。npm workspaces を使用。
npm install

cp .env.example .env    # 任意 —— 各変数に妥当な開発デフォルトあり
```

## 開発

```bash
npm run dev
# 並行実行：
#   nest start --watch   → サーバー :3200
#   vite                 → レンダラー :5173
#   electron             → 3 秒後にウィンドウを開く
```

Vite 開発サーバーは `/api/*`（`/api` を除去）と `/music/*` を `:3200` の
NestJS にプロキシします。そのため開発時はアプリ全体が同一オリジンとなり、
1 つのセッション cookie を共有します。

## 環境変数

開発時はすべて任意で、サーバーは妥当なデフォルトにフォールバックします。

| 変数 | デフォルト | 備考 |
| --- | --- | --- |
| `PORT` | `3200` | NestJS ポート |
| `RENDERER_BASE` | `http://localhost:5173` | ログイン後のリダイレクト基点 |
| `RENDERER_ORIGINS` | `http://localhost:5173,http://localhost:3000` | CORS 許可リスト |
| `SESSION_SECRET` | 開発用プレースホルダ | Cookie 署名鍵 —— **本番では設定必須** |
| `SESSION_TTL_MS` | 30 日 | セッション有効期間 |
| `STORAGE_DIR` | `.storage` | `state.json` の保存先 |
| `NETEASE_MUSIC_U` | – | 開発専用：NetEase `MUSIC_U` cookie を注入 |
| `NETEASE_QR_POLL_MS` | `1500` | QR ポーリング間隔 |
| `DEEPSEEK_API_KEY` | – | 📋 予定 —— レコメンド用の DeepSeek キー |

---

## 各ソースへのログイン

- **NetEase Cloud Music** —— 「登录」をクリックし、NetEase のスマホアプリで
  QR コードをスキャンして確認。サーバーが NetEase の平文
  `/api/login/qrcode/*` エンドポイントを直接叩き、成功時に `Set-Cookie` から
  `MUSIC_U` を取得します。「`MUSIC_U` を手動貼り付け」のフォールバックもあり。
  cookie は約 30 日有効で、`301` が返り始めたら再スキャンしてください。
- **QQ Music** —— 「登录」をクリック（デスクトップアプリのみ）。Maestro が
  埋め込みの QQ Music ログインウィンドウを開き、実際のログイン cookie
  （`qm_keyst` / `qqmusic_key` / `uin`）を取得します。QQ Connect OAuth は
  **不使用**、AppID/シークレット不要。以降、検索とフル尺再生（標準 / 320 kbps
  / ロスレス）が可能。ロスレスには QQ Music の会員が必要です。
- **Deezer** —— ログイン不要。匿名の公開編集チャートで 30 秒プレビューを再生。
- **Spotify** —— ✅ OAuth PKCE ログイン ♥ 書き戻し（`PUT /v1/me/tracks`）
  と統合 ♥ 一括付与への参加。Premium アカウントでは castLabs Electron fork
  + Web Playback SDK + Widevine でフル尺再生（要 EVS VMP 署名によるパッケージ
  ング後の最終確認）。Free は 30 秒プレビューのまま。

---

## 本番ビルド

```bash
npm run build                         # server + renderer + electron
cd packages/electron && npm run pack  # electron-builder で macOS dmg を出す
```

> **本番パッケージング進捗：** NestJS サイドカー化 / prod API ベース配線 /
> macOS Tray / カスタム Dock アイコン（specs/packaging #15）は完了。残りは
> `npm run pack` のエンドツーエンドスモーク（packaging spec task 16）と
> Widevine VMP 署名（`afterPack-vmp.cjs` を `castlabs_evs` EVS アカウントで
> 有効化、EVS サインアップは本機手動）。

---

## プライバシーとセキュリティ

これは**ローカルファーストの個人用ツール**です。プラットフォームの cookie
（`MUSIC_U`、QQ ログイン cookie）、セッション、そして将来の DeepSeek API
キーは、あなた自身のマシン上の `packages/server/.storage/` に平文で保存され、
**git 管理外**です。Maestro が運営するサービス（存在しません）へアップロード
されるものは一切ありません。`.storage/` はパスワードファイルと同様に扱って
ください。

## ライセンス

MIT
