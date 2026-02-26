# サーバー移行手順書 — lche2.xvps.jp

> 対象: 新サーバー (lche2.xvps.jp / 162.43.31.143) での Nexus インフラ構築
> 前提: Claude Code が新サーバーで稼働している状態

## 概要

旧サーバー (lche.xvps.jp / 210.131.219.93) から新サーバーへ Nexus 関連サービスを移行する。
コード・設定ファイル内のドメイン/IP は既に `lche2.xvps.jp` / `162.43.31.143` に更新済み。

**移行対象** (Nexus のみ):
- LiveKit SFU (nexus-livekit)
- JWT サービス (nexus-jwt)
- Nginx TLS 終端 (nexus-nginx)

**移行しないもの**: cfrp-market（別プロジェクト）

---

## Step 0: 依存環境のインストール

まっさらな Ubuntu サーバーを前提とする。以下を順番にインストールする。

### 0-1. 基本パッケージ

```bash
apt update && apt upgrade -y
apt install -y git curl wget ca-certificates gnupg lsb-release
```

### 0-2. Docker Engine + Docker Compose

```bash
# Docker 公式 GPG キーを追加
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

# リポジトリを追加
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

# インストール
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 動作確認
docker --version        # Docker Engine 27.x+
docker compose version  # Docker Compose v2.x+
```

### 0-3. certbot（SSL 証明書取得用）

```bash
apt install -y certbot
```

### 0-4. 確認

```bash
docker --version         # 必須: Docker Engine
docker compose version   # 必須: Docker Compose v2
certbot --version        # 必須: certbot
git --version            # 必須: git
curl --version           # 必須: curl
```

> **Note**: pnpm / Node.js はこのサーバーには不要。ビルドは GitHub Actions で行い、
> このサーバーは Docker で LiveKit SFU を動かすだけ。

---

## Step 1: プロジェクト知識の取得

```bash
# リポジトリをクローン
git clone https://github.com/mi2h1/nexus.git /root/dev/nexus
cd /root/dev/nexus
```

**必読ドキュメント** (優先順):
1. `CLAUDE.md` — プロジェクトルール・コミュニケーション規約
2. `HANDOVER.md` — セッション引継書（現状の全体像）
3. `docs/app-spec.md` — アプリ仕様・VC アーキテクチャ
4. `docs/progress.md` — 進捗・作業ログ
5. `docs/vc-optimization.md` — VC 接続高速化の詳細
6. `docs/conventions.md` — 開発規約

---

## Step 2: SSL 証明書の配置

SSL 証明書が `lche2.xvps.jp` 用に発行されている前提。

```bash
# 証明書ディレクトリを作成
mkdir -p /etc/ssl/lche2

# 証明書を配置（以下のファイルが必要）
# - /etc/ssl/lche2/fullchain.pem  (フルチェーン証明書)
# - /etc/ssl/lche2/privkey.pem    (秘密鍵)
#
# certbot で取得した場合:
# cp /etc/letsencrypt/live/lche2.xvps.jp/fullchain.pem /etc/ssl/lche2/
# cp /etc/letsencrypt/live/lche2.xvps.jp/privkey.pem /etc/ssl/lche2/

# パーミッション確認（Docker の nginx が読めること）
chmod 644 /etc/ssl/lche2/fullchain.pem
chmod 600 /etc/ssl/lche2/privkey.pem
```

---

## Step 3: ファイアウォール設定

以下のポートを開放する:

| ポート | プロトコル | 用途 |
|--------|-----------|------|
| 7880 | TCP | LiveKit WebSocket (WSS) |
| 7881 | TCP | LiveKit TCP フォールバック |
| 7882 | UDP | WebRTC メディア |
| 7891 | TCP | JWT サービス (HTTPS) |

```bash
# ufw の場合
ufw allow 7880/tcp
ufw allow 7881/tcp
ufw allow 7882/udp
ufw allow 7891/tcp

# iptables の場合
iptables -A INPUT -p tcp --dport 7880 -j ACCEPT
iptables -A INPUT -p tcp --dport 7881 -j ACCEPT
iptables -A INPUT -p udp --dport 7882 -j ACCEPT
iptables -A INPUT -p tcp --dport 7891 -j ACCEPT
```

---

## Step 4: lk-jwt-service カスタムビルド

`lk-jwt-service` はユーザーホワイトリスト機能を追加したカスタム版を使用する。

```bash
# ソースは /root/lk-jwt-service にある
cd /root/lk-jwt-service
docker build --build-arg GO_VERSION=1.23 -t nexus-lk-jwt-service:latest .
```

### ホワイトリスト管理

`docker-compose.yml` の `LIVEKIT_ALLOWED_USER_IDS` にカンマ区切りで Matrix ユーザー ID を設定:
```yaml
LIVEKIT_ALLOWED_USER_IDS: "@user1:matrix.org,@user2:matrix.org"
```
- 未設定 = 全ユーザー許可（既存互換）
- ホワイトリスト外のユーザーには `403 M_FORBIDDEN` を返す
- ユーザー追加後は `docker compose up -d lk-jwt-service` で反映（数秒のダウンタイム）

### ロールバック

`docker-compose.yml` の image を `ghcr.io/element-hq/lk-jwt-service:latest` に戻し、
`LIVEKIT_ALLOWED_USER_IDS` を削除して `docker compose up -d lk-jwt-service`。

---

## Step 5: Docker で Nexus サービスを起動

```bash
cd /root/dev/nexus/infra/livekit
docker compose up -d
```

これで 3 コンテナが起動する:
- `nexus-livekit` — LiveKit SFU
- `nexus-jwt` — JWT 発行サービス (カスタムビルド、OpenID 検証 + ホワイトリスト → LiveKit JWT)
- `nexus-nginx` — TLS 終端 (7880 WSS, 7891 HTTPS)

---

## Step 6: 動作確認

### 6-1. コンテナ状態

```bash
docker ps
# 3 コンテナ全て "Up" であること
```

### 6-2. JWT エンドポイント

```bash
curl -k https://lche2.xvps.jp:7891/healthz
# または単純に接続確認
curl -k -o /dev/null -w "%{http_code}" https://lche2.xvps.jp:7891/
```

### 6-3. LiveKit WebSocket

```bash
# WebSocket 接続テスト（upgrade が返ること）
curl -k -I -H "Upgrade: websocket" -H "Connection: Upgrade" https://lche2.xvps.jp:7880/
```

### 6-4. ブラウザ確認

1. https://mi2h1.github.io/nexus/ を開く
2. ログイン → VC チャンネルに参加
3. ブラウザの開発者ツール Network タブで `lche2.xvps.jp` への接続を確認
4. 2台のブラウザで同じ VC に入り音声通話を確認

---

## Step 7: certbot 自動更新の設定（推奨）

```bash
# certbot の renew hook で証明書をコピー + nginx リロード
# /etc/letsencrypt/renewal-hooks/deploy/nexus-ssl.sh
cat > /etc/letsencrypt/renewal-hooks/deploy/nexus-ssl.sh << 'SCRIPT'
#!/bin/bash
cp /etc/letsencrypt/live/lche2.xvps.jp/fullchain.pem /etc/ssl/lche2/
cp /etc/letsencrypt/live/lche2.xvps.jp/privkey.pem /etc/ssl/lche2/
docker exec nexus-nginx nginx -s reload
SCRIPT
chmod +x /etc/letsencrypt/renewal-hooks/deploy/nexus-ssl.sh
```

---

## 設定ファイルの場所

| ファイル | 用途 |
|---------|------|
| `infra/livekit/docker-compose.yml` | Docker サービス定義 (ホワイトリスト設定含む) |
| `infra/livekit/livekit.yaml` | LiveKit SFU 設定 (node_ip, ポート, API キー) |
| `infra/livekit/nginx.conf` | Nginx TLS 終端 + CORS 設定 |
| `/root/lk-jwt-service/main.go` | lk-jwt-service カスタム版ソース (ホワイトリスト機能) |
| `src/models/NexusVoiceConnection.ts:94` | JWT サービス URL (クライアント側) |

---

## トラブルシューティング

### JWT 取得に失敗する
```bash
# nginx ログ確認
docker logs nexus-nginx --tail 50
# JWT サービスログ確認
docker logs nexus-jwt --tail 50
```
- CORS エラー → `nginx.conf` の `Access-Control-Allow-Origin` を確認
- SSL エラー → 証明書パス `/etc/ssl/lche2/` にファイルがあるか確認

### WebRTC 接続が確立しない
```bash
# LiveKit ログ確認
docker logs nexus-livekit --tail 50
```
- ICE candidate エラー → `livekit.yaml` の `node_ip: 162.43.31.143` を確認
- ポートが閉じている → ファイアウォールで 7882/udp が開いているか確認

### コンテナが起動しない
```bash
docker compose logs
```
- `bind: address already in use` → 該当ポートを使っているプロセスを確認 (`ss -tlnp`)
- 証明書が見つからない → `/etc/ssl/lche2/` に `fullchain.pem` と `privkey.pem` があるか確認

---

## 旧サーバーの停止 — ✅ 完了

旧サーバー (lche.xvps.jp) の Nexus コンテナは 2026-02-26 に停止済み。
コード内の旧ドメイン/IP への参照も全て削除済み。
