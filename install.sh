#!/bin/bash
# Schedule 4 Real - Installer
#
# Usage: curl -sL https://schedule4real.com/dist/install/install.sh | bash
#
# Installs the Schedule 4 Real control system
# Requirements: Docker, curl
#
# Author: Ptakx (opengrow.pt)

set -e

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}  [OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

INSTALL_DIR="$(pwd)/schedule-4-real"
DOWNLOAD_URL="https://schedule4real.com/dist/install/schedule-4-real.tar.gz"

# Detect local IP address
get_local_ip() {
    # Try common methods to get the primary LAN IP
    local ip=""
    ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1) ||
    ip=$(hostname -I 2>/dev/null | awk '{print $1}') ||
    ip=$(ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')
    echo "${ip:-localhost}"
}

LOCAL_IP=$(get_local_ip)

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}║${NC}   ${BOLD}SCHEDULE 4 REAL${NC}                                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ${DIM}by Ptakx${NC}                                        ${GREEN}║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# ═══════════════════════════════════════════
# Verificar permisos root
# ═══════════════════════════════════════════
if [ "$EUID" -ne 0 ]; then
    error "This installer requires root. Run with sudo."
fi

# ═══════════════════════════════════════════
# 1. Check requirements
# ═══════════════════════════════════════════
info "Checking system requirements..."

if ! command -v docker &>/dev/null; then
    error "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
fi
success "Docker installed"

if ! command -v curl &>/dev/null && ! command -v wget &>/dev/null; then
    error "curl or wget is required"
fi

# Docker must be running
if ! docker info &>/dev/null; then
    warning "Docker is installed but not running. Starting Docker..."
    systemctl start docker 2>/dev/null || true
    sleep 2
    if ! docker info &>/dev/null; then
        error "Docker is not running. Start it with: systemctl start docker"
    fi
fi
success "Docker engine running"

# Detect system architecture
MACHINE_ARCH=$(uname -m)
case "$MACHINE_ARCH" in
    x86_64)  ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    armv7l|armv6l)
        error "32-bit ARM is not supported. Requires 64-bit OS on Raspberry Pi 4+ with 2GB+ RAM." ;;
    *)
        error "Unsupported architecture: $MACHINE_ARCH. Supported: x86_64, aarch64 (ARM64)." ;;
esac
success "Architecture: $MACHINE_ARCH ($ARCH)"

# RAM check for ARM64 (QuestDB needs at least ~2GB)
if [ "$ARCH" = "arm64" ]; then
    TOTAL_RAM_MB=$(free -m 2>/dev/null | awk '/Mem:/ {print $2}')
    if [ -n "$TOTAL_RAM_MB" ] && [ "$TOTAL_RAM_MB" -lt 1800 ]; then
        error "Insufficient RAM: ${TOTAL_RAM_MB}MB detected. Minimum 2GB required for ARM64 (QuestDB needs it)."
    fi
    if [ -n "$TOTAL_RAM_MB" ]; then
        success "RAM: ${TOTAL_RAM_MB}MB"
    fi
fi

echo ""

# ═══════════════════════════════════════════
# 1b. Pre-scan for port conflicts
# ═══════════════════════════════════════════
echo -e "${CYAN}── PRE-FLIGHT PORT SCAN ────────────────${NC}"
echo ""

# Helper: check if port is in use
port_in_use() {
    if command -v lsof &>/dev/null; then
        lsof -Pi :"$1" -sTCP:LISTEN -t >/dev/null 2>&1
    elif command -v ss &>/dev/null; then
        ss -tlnp | grep -q ":$1 "
    else
        return 1
    fi
}

# Get process name using a port
port_process() {
    if command -v lsof &>/dev/null; then
        lsof -Pi :"$1" -sTCP:LISTEN 2>/dev/null | tail -1 | awk '{print $1}'
    elif command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep ":$1 " | sed 's/.*"\(.*\)".*/\1/' | head -1
    fi
}

DEFAULT_PORTS=("3000:Web App" "1883:MQTT Broker" "1884:MQTT LAN" "8812:QuestDB DB" "9000:QuestDB Console" "9009:QuestDB Writer" "8883:MQTT Proxy" "9443:Relay Node")
CONFLICTS_FOUND=0

for entry in "${DEFAULT_PORTS[@]}"; do
    IFS=':' read -r port label <<< "$entry"
    if port_in_use "$port"; then
        proc=$(port_process "$port")
        echo -e "  ${RED}CONFLICT${NC}  Port ${BOLD}${port}${NC} (${label}) is in use by ${YELLOW}${proc:-unknown}${NC}"
        CONFLICTS_FOUND=$((CONFLICTS_FOUND + 1))
    else
        echo -e "  ${GREEN}FREE${NC}      Port ${BOLD}${port}${NC} (${label})"
    fi
done

echo ""
if [ "$CONFLICTS_FOUND" -gt 0 ]; then
    warning "${CONFLICTS_FOUND} port conflict(s) detected. You will be prompted to choose alternative ports."
else
    success "All default ports are available"
fi
echo ""

# ═══════════════════════════════════════════
# 2. Install system dependencies (non-Node)
# ═══════════════════════════════════════════
info "Installing system dependencies..."

# Detect package manager
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt-get"
    apt-get update -qq
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
else
    warning "Package manager not detected"
    PKG_MANAGER="manual"
fi

# Mosquitto
if ! command -v mosquitto &>/dev/null; then
    info "Installing Mosquitto..."
    $PKG_MANAGER install -y mosquitto
    systemctl stop mosquitto 2>/dev/null || true
    systemctl disable mosquitto 2>/dev/null || true
fi
success "Mosquitto available"

# FFmpeg (timelapse video generation)
if ! command -v ffmpeg &>/dev/null; then
    info "Installing FFmpeg..."
    $PKG_MANAGER install -y ffmpeg
fi
success "FFmpeg available"

# ImageMagick (photo overlays)
if ! command -v convert &>/dev/null; then
    info "Installing ImageMagick..."
    $PKG_MANAGER install -y imagemagick
fi
success "ImageMagick available"

# lsof
if ! command -v lsof &>/dev/null; then
    $PKG_MANAGER install -y lsof 2>/dev/null || true
fi

echo ""

# ═══════════════════════════════════════════
# 3. Download and extract
# ═══════════════════════════════════════════
info "Downloading Schedule 4 Real..."

TMP_FILE="/tmp/schedule-4-real.tar.gz"
if command -v curl &>/dev/null; then
    curl -L "$DOWNLOAD_URL" -o "$TMP_FILE"
else
    wget -O "$TMP_FILE" "$DOWNLOAD_URL"
fi

if [ ! -f "$TMP_FILE" ]; then
    error "Failed to download package"
fi
success "Package downloaded"

info "Extracting to ${INSTALL_DIR}..."
rm -rf "$INSTALL_DIR"
tar xzf "$TMP_FILE" -C "$(pwd)/"
rm -f "$TMP_FILE"

if [ ! -d "$INSTALL_DIR" ]; then
    error "Failed to extract package"
fi
success "Extracted to ${INSTALL_DIR}"

cd "$INSTALL_DIR"

# Select correct proxy binary for this architecture
if [ "$ARCH" = "arm64" ] && [ -f "proxy/spiderproxy-arm64" ]; then
    mv proxy/spiderproxy-arm64 proxy/spiderproxy
    chmod +x proxy/spiderproxy
    success "Using ARM64 proxy binary"
elif [ "$ARCH" = "arm64" ] && [ ! -f "proxy/spiderproxy-arm64" ]; then
    warning "ARM64 proxy binary not found in package. Proxy may not work on this architecture."
elif [ -f "proxy/spiderproxy-arm64" ]; then
    rm -f proxy/spiderproxy-arm64
fi

echo ""

# ═══════════════════════════════════════════
# 3b. Download appdata assets (models, images, sound, fonts, defaults)
# ═══════════════════════════════════════════
APPDATA_INDEX_URL="https://schedule4real.com/dist/install/appdata/appdata-index.json"
APPDATA_BASE_URL="https://schedule4real.com/dist/install/appdata"
APPDATA_DIR="${INSTALL_DIR}/data/appdata"

info "Downloading appdata assets (3D models, images, sounds, fonts)..."

mkdir -p "$APPDATA_DIR"

# Download the index
APPDATA_INDEX_FILE="/tmp/appdata-index.json"
if curl -sL "$APPDATA_INDEX_URL" -o "$APPDATA_INDEX_FILE" 2>/dev/null && [ -s "$APPDATA_INDEX_FILE" ]; then
    # Parse file count
    APPDATA_COUNT=$(python3 -c "import json; print(len(json.load(open('$APPDATA_INDEX_FILE')).get('files',{})))" 2>/dev/null || echo "0")

    if [ "$APPDATA_COUNT" -gt 0 ]; then
        info "  Found $APPDATA_COUNT assets to download"

        # Download each file
        DOWNLOADED=0
        FAILED=0
        python3 -c "import json; [print(p) for p in json.load(open('$APPDATA_INDEX_FILE'))['files'].keys()]" | while IFS= read -r filepath; do
            local_path="${APPDATA_DIR}/${filepath}"
            local_dir=$(dirname "$local_path")
            mkdir -p "$local_dir"

            # URL-encode spaces in filepath
            encoded_path=$(echo "$filepath" | sed 's/ /%20/g')

            if curl -sL "${APPDATA_BASE_URL}/${encoded_path}" -o "$local_path" 2>/dev/null && [ -s "$local_path" ]; then
                DOWNLOADED=$((DOWNLOADED + 1))
                # Show progress every 10 files
                if [ $((DOWNLOADED % 10)) -eq 0 ]; then
                    echo -ne "\r  Downloaded: ${DOWNLOADED}/${APPDATA_COUNT} files"
                fi
            else
                FAILED=$((FAILED + 1))
                rm -f "$local_path"
            fi
        done
        echo ""

        # Save the index locally for future sync
        cp "$APPDATA_INDEX_FILE" "${APPDATA_DIR}/appdata-index.json"
        success "Appdata assets downloaded"
    else
        warning "Appdata index is empty or invalid"
    fi
else
    warning "Could not download appdata index. Assets will be synced on first update check."
fi

rm -f "$APPDATA_INDEX_FILE"

echo ""

# ═══════════════════════════════════════════
# 4. Install Node.js (version from .nvmrc)
# ═══════════════════════════════════════════
REQUIRED_NODE_MAJOR=22
if [ -f ".nvmrc" ]; then
    REQUIRED_NODE_MAJOR=$(cat .nvmrc | tr -d '[:space:]')
    info "Required Node.js version: ${REQUIRED_NODE_MAJOR} (from .nvmrc)"
fi

CURRENT_NODE_MAJOR=0
if command -v node &>/dev/null; then
    CURRENT_NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d v)
fi

if [ "$CURRENT_NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] 2>/dev/null; then
    info "Installing Node.js ${REQUIRED_NODE_MAJOR} (current: v${CURRENT_NODE_MAJOR:-none})..."
    curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
    $PKG_MANAGER install -y nodejs
fi
success "Node.js $(node -v)"

# PM2
if ! command -v pm2 &>/dev/null; then
    info "Installing PM2..."
    npm install -g pm2
fi
success "PM2 $(pm2 -v 2>/dev/null || echo 'installed')"

echo ""

# ═══════════════════════════════════════════
# 5. Install project dependencies
# ═══════════════════════════════════════════
info "Installing Node.js dependencies..."
npm ci --omit=dev 2>&1 | tail -5
success "Node.js dependencies installed"

echo ""

# ═══════════════════════════════════════════
# 6. Configure environment
# ═══════════════════════════════════════════
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        success "Environment file created from template"
    fi
else
    success "Environment file exists, preserving"
fi

# ═══════════════════════════════════════════
# 6b. Interactive port configuration
# ═══════════════════════════════════════════

# Helper: update a key in .env
env_set() {
    local key="$1" value="$2"
    if grep -q "^${key}=" .env 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
        echo "${key}=${value}" >> .env
    fi
}

echo ""
echo -e "${CYAN}── PORT CONFIGURATION ─────────────────${NC}"
echo ""
info "Each service needs a TCP port. Press ${BOLD}Enter${NC} to use the default."
if [ "$CONFLICTS_FOUND" -gt 0 ]; then
    warning "Ports marked ${RED}[CONFLICT]${NC} need a different value."
fi
echo ""

# Port definitions: VAR_NAME:DEFAULT:LABEL
PORT_DEFS=(
    "API_PORT:3000:Web App (HTTP)"
    "MQTT_PORT:1883:MQTT Broker (internal)"
    "MQTT_LAN_PORT:1884:MQTT Broker (LAN)"
    "MQTT_WS_PORT:9001:MQTT WebSocket"
    "QUESTDB_PG_PORT:8812:QuestDB Database"
    "QUESTDB_HTTP_PORT:9000:QuestDB Console"
    "QUESTDB_ILP_PORT:9009:QuestDB Writer"
    "RELAY_PORT:9443:Relay Node"
)

declare -A CHOSEN_PORTS

for def in "${PORT_DEFS[@]}"; do
    IFS=':' read -r var_name default_port label <<< "$def"

    conflict=""
    if port_in_use "$default_port"; then
        proc=$(port_process "$default_port")
        conflict=" ${RED}[CONFLICT: ${proc:-unknown}]${NC}"
    fi

    while true; do
        echo -ne "  ${label} [${BOLD}${default_port}${NC}]${conflict}: "
        read user_port
        user_port=${user_port:-$default_port}

        # Validate numeric and range
        if ! [[ "$user_port" =~ ^[0-9]+$ ]] || [ "$user_port" -lt 1024 ] || [ "$user_port" -gt 65535 ]; then
            warning "  Port must be between 1024 and 65535"
            continue
        fi

        # Warn if chosen port is in use (and different from default, since default was already warned)
        if [ "$user_port" != "$default_port" ] && port_in_use "$user_port"; then
            proc=$(port_process "$user_port")
            warning "  Port $user_port is also in use by ${proc:-unknown}"
            continue
        fi

        # Check duplicate
        dup=false
        for chosen in "${CHOSEN_PORTS[@]}"; do
            if [ "$chosen" = "$user_port" ]; then
                warning "  Port $user_port is already assigned to another service"
                dup=true
                break
            fi
        done
        $dup && continue

        CHOSEN_PORTS[$var_name]=$user_port
        break
    done
done

# PROXY_PORT is fixed (compiled binary)
echo ""
echo -e "  MQTT Proxy (TLS):  ${BOLD}8883${NC} ${YELLOW}[FIXED - compiled binary]${NC}"
CHOSEN_PORTS[PROXY_PORT]=8883

# App password
echo ""
echo -e "${CYAN}── APP PASSWORD ───────────────────────${NC}"
echo ""
echo -ne "  Login password [${BOLD}spiderdream${NC}]: "
read user_password
user_password=${user_password:-spiderdream}

# Write all ports to .env
for var_name in "${!CHOSEN_PORTS[@]}"; do
    env_set "$var_name" "${CHOSEN_PORTS[$var_name]}"
done
env_set "APP_PASSWORD" "$user_password"

# Enable remote tunnel access by default (invite-only via room key)
env_set "TUNNEL_ENABLED" "true"

echo ""
success "Configuration saved to .env"

# Export for use in this script
for var_name in "${!CHOSEN_PORTS[@]}"; do
    export "$var_name=${CHOSEN_PORTS[$var_name]}"
done

echo ""

# ═══════════════════════════════════════════
# 7. Create directories
# ═══════════════════════════════════════════
mkdir -p database/data
mkdir -p proxy/mosquitto_data
mkdir -p logs
mkdir -p data/relay

# Create default relay config (relay + tracker enabled)
if [ ! -f data/relay/relay-config.json ]; then
    RELAY_PORT_VAL=${CHOSEN_PORTS[RELAY_PORT]:-9443}
    echo "{\"enabled\":true,\"trackerEnabled\":true,\"port\":${RELAY_PORT_VAL}}" > data/relay/relay-config.json
    info "Created relay config with relay + tracker enabled (port ${RELAY_PORT_VAL})"
fi

# ═══════════════════════════════════════════
# 7b. Generate mosquitto.conf
# ═══════════════════════════════════════════
cat > proxy/mosquitto.conf << MOSQ_EOF
# Mosquitto Local Broker - Schedule 4 Real
# Auto-generated by installer

listener ${MQTT_PORT:-1883} 127.0.0.1
listener ${MQTT_LAN_PORT:-1884} 0.0.0.0

listener ${MQTT_WS_PORT:-9001} 0.0.0.0
protocol websockets

allow_anonymous true

log_type all
log_dest stdout

persistence true
persistence_location proxy/mosquitto_data/

retain_available true
MOSQ_EOF
success "Mosquitto config generated (ports ${MQTT_PORT:-1883}/${MQTT_LAN_PORT:-1884}/${MQTT_WS_PORT:-9001}-ws)"

# ═══════════════════════════════════════════
# 8. Start QuestDB
# ═══════════════════════════════════════════
info "Starting QuestDB..."

QUESTDB_USER=${QUESTDB_USER:-spider}
QUESTDB_PASSWORD=${QUESTDB_PASSWORD:-spider123}
if [ -f ".env" ]; then
    source <(grep -v '^#' .env | grep -E '^(QUESTDB_USER|QUESTDB_PASSWORD)=' | sed 's/\r$//')
fi

QDB_PG=${QUESTDB_PG_PORT:-8812}
QDB_HTTP=${QUESTDB_HTTP_PORT:-9000}
QDB_ILP=${QUESTDB_ILP_PORT:-9009}

if docker ps --filter name=s4r-questdb --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    success "QuestDB already running"
else
    docker rm s4r-questdb 2>/dev/null || true
    docker run -d \
        --name s4r-questdb \
        --restart=always \
        -p ${QDB_PG}:8812 -p ${QDB_HTTP}:9000 -p ${QDB_ILP}:9009 \
        -v "${INSTALL_DIR}/database/data:/var/lib/questdb" \
        -e QDB_PG_USER="${QUESTDB_USER}" \
        -e QDB_PG_PASSWORD="${QUESTDB_PASSWORD}" \
        -e QDB_TELEMETRY_ENABLED=false \
        questdb/questdb:latest

    info "Waiting for QuestDB..."
    for i in {1..30}; do
        # Port 9000 here is the container-internal port (always 9000 inside Docker, regardless of host mapping)
        if docker exec s4r-questdb curl -s http://localhost:9000/exec?query=SELECT+1 >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    success "QuestDB ready"
fi

echo ""

# ═══════════════════════════════════════════
# 9. Initialize database
# ═══════════════════════════════════════════
info "Initializing database tables..."
node src/db/init.js 2>/dev/null && success "Tables initialized" || warning "init.js failed (tables may already exist)"

echo ""

# ═══════════════════════════════════════════
# 10. Start services
# ═══════════════════════════════════════════
info "Starting services..."
chmod +x pm2-start.sh kill.sh
[ -f "start-vital.sh" ] && chmod +x start-vital.sh
[ -f "stop-vital.sh" ] && chmod +x stop-vital.sh
[ -f "update.sh" ] && chmod +x update.sh

./pm2-start.sh

echo ""

# ═══════════════════════════════════════════
# 10b. Optional: Reverse proxy (Nginx) setup
# ═══════════════════════════════════════════
echo -e "${CYAN}── REVERSE PROXY (optional) ────────────${NC}"
echo ""
echo -e "  A reverse proxy enables ${BOLD}HTTPS${NC}, custom domains, and secure remote access."
echo -e "  It also enables voice chat and asset caching in 3D rooms."
echo ""
echo -ne "  Would you like to install and configure ${BOLD}Nginx${NC}? [y/N]: "
read INSTALL_NGINX
INSTALL_NGINX=${INSTALL_NGINX:-n}

if [[ "$INSTALL_NGINX" =~ ^[Yy]$ ]]; then
    echo ""
    echo -ne "  Enter your domain (e.g., ${BOLD}mydomain.com${NC}) or press Enter to skip: "
    read USER_DOMAIN
    USER_DOMAIN=$(echo "$USER_DOMAIN" | xargs)

    if [ -n "$USER_DOMAIN" ]; then
        info "Installing Nginx..."
        apt-get install -y nginx >/dev/null 2>&1 && success "Nginx installed" || { warning "Failed to install Nginx"; INSTALL_NGINX="n"; }
    else
        info "No domain provided — skipping Nginx setup."
        INSTALL_NGINX="n"
    fi

    if [[ "$INSTALL_NGINX" =~ ^[Yy]$ ]] && [ -n "$USER_DOMAIN" ]; then
        RELAY_PORT_VAL=${CHOSEN_PORTS[RELAY_PORT]:-9443}

        # Generate Nginx config (relay uses /relay path, no subdomain needed)
        cat > /etc/nginx/sites-available/schedule4real << NGINX_EOF
# Schedule 4 Real — Auto-generated by installer
# ${USER_DOMAIN} → port ${API_PORT:-3000}, /relay → port ${RELAY_PORT_VAL}

server {
    listen 80;
    server_name ${USER_DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${USER_DOMAIN};

    # SSL certificates will be added by certbot
    # ssl_certificate ...
    # ssl_certificate_key ...

    location ~ ^/(models|images|sound|fonts|defaults)/ {
        proxy_pass http://127.0.0.1:${API_PORT:-3000};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        expires off;
        add_header Cache-Control "no-store, no-cache";
    }

    # Relay Node (WebSocket) — /relay
    location /relay {
        proxy_pass http://127.0.0.1:${RELAY_PORT_VAL}/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /_ws {
        proxy_pass http://127.0.0.1:${API_PORT:-3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /_room3d-ws {
        proxy_pass http://127.0.0.1:${API_PORT:-3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location /mqtt {
        proxy_pass http://127.0.0.1:9001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    location / {
        proxy_pass http://127.0.0.1:${API_PORT:-3000};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX_EOF

        # Enable site
        rm -f /etc/nginx/sites-enabled/default
        ln -sf /etc/nginx/sites-available/schedule4real /etc/nginx/sites-enabled/
        nginx -t 2>/dev/null && systemctl reload nginx && success "Nginx configured for ${USER_DOMAIN}" || warning "Nginx config test failed"

        # Save domain to .env
        env_set "APP_DOMAIN" "$USER_DOMAIN"

        # Optional: SSL with certbot
        echo ""
        echo -ne "  Install SSL certificate with Let's Encrypt? [Y/n]: "
        read INSTALL_SSL
        INSTALL_SSL=${INSTALL_SSL:-y}

        if [[ "$INSTALL_SSL" =~ ^[Yy]$ ]]; then
            echo -ne "  Email for SSL notifications: "
            read SSL_EMAIL
            if [ -n "$SSL_EMAIL" ]; then
                info "Installing certbot..."
                apt-get install -y certbot python3-certbot-nginx >/dev/null 2>&1
                info "Requesting SSL certificate..."
                certbot --nginx -d "$USER_DOMAIN" --non-interactive --agree-tos -m "$SSL_EMAIL" 2>&1 | tail -5
                if [ $? -eq 0 ]; then
                    success "SSL certificate installed for ${USER_DOMAIN}"

                    # Update relay public URL to use wss://domain/relay
                    RELAY_WSS_URL="wss://${USER_DOMAIN}/relay"
                    if [ -f data/relay/relay-config.json ]; then
                        node -e "
                            const fs = require('fs');
                            const p = 'data/relay/relay-config.json';
                            const c = JSON.parse(fs.readFileSync(p,'utf8'));
                            c.publicUrl = '${RELAY_WSS_URL}';
                            fs.writeFileSync(p, JSON.stringify(c, null, 2));
                        " 2>/dev/null
                    fi
                else
                    warning "SSL setup failed. You can retry later: sudo certbot --nginx -d ${USER_DOMAIN}"
                fi
            else
                info "No email provided — skipping SSL."
            fi
        fi
    fi
else
    info "Skipping reverse proxy setup. You can set it up later from the app."
fi

echo ""

# ═══════════════════════════════════════════
# 11. Configure auto-start on boot
# ═══════════════════════════════════════════
info "Configuring auto-start on boot..."
pm2 startup 2>/dev/null | grep -v "^\[" | bash 2>/dev/null || true
pm2 save
success "Auto-start configured"

echo ""

# ═══════════════════════════════════════════
# Installation complete - Summary
# ═══════════════════════════════════════════
WEB_PORT=${API_PORT:-3000}

echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}║${NC}   ${BOLD}INSTALLATION COMPLETE${NC}                            ${GREEN}║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}── ACCESS YOUR APP ────────────────────${NC}"
echo ""
echo -e "  Open your browser and go to:"
echo ""
echo -e "    ${BOLD}${GREEN}http://${LOCAL_IP}:${API_PORT:-3000}${NC}"
echo ""
echo -e "  Login with password: ${BOLD}${user_password:-spiderdream}${NC}"
echo -e "  ${DIM}(Change it in Settings > Security after first login)${NC}"
echo ""
echo -e "${CYAN}── SERVICES ───────────────────────────${NC}"
echo ""
echo -e "  Web App:       ${BOLD}http://${LOCAL_IP}:${API_PORT:-3000}${NC}"
echo -e "  MQTT Broker:   ${BOLD}${LOCAL_IP}:${MQTT_PORT:-1883}${NC} (internal) / ${BOLD}:${MQTT_LAN_PORT:-1884}${NC} (LAN)"
echo -e "  MQTT Proxy:    ${BOLD}${LOCAL_IP}:${PROXY_PORT:-8883}${NC} (TLS)"
echo -e "  QuestDB:       ${BOLD}http://${LOCAL_IP}:${QDB_HTTP}${NC} (console)"
echo ""
echo -e "${CYAN}── NEXT STEPS ─────────────────────────${NC}"
echo ""
echo -e "  1. Point NAT port ${BOLD}${PROXY_PORT:-8883}${NC} on your router to this machine (${LOCAL_IP})"
echo -e "  2. Devices auto-detect once traffic flows through the proxy"
echo -e "  3. Access the web app and configure your grow environment"
echo ""
echo -e "${CYAN}── USEFUL COMMANDS ────────────────────${NC}"
echo ""
echo -e "  ${DIM}cd ${INSTALL_DIR}${NC}"
echo -e "  pm2 logs              ${DIM}View all service logs${NC}"
echo -e "  pm2 monit             ${DIM}Real-time monitoring${NC}"
echo -e "  ./kill.sh             ${DIM}Stop all services${NC}"
echo -e "  ./pm2-start.sh        ${DIM}Start all services${NC}"
echo ""
echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo -e "${DIM}  Schedule 4 Real${NC}"
echo -e "${DIM}  Crafted by ${NC}${BOLD}Ptakx${NC} ${DIM}(opengrow.pt)${NC}"
echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo ""

exit 0
