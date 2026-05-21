#!/bin/bash
# Schedule 4 Real - Iniciar todos los servicios
#
# Servicios VITALES (siempre activos):
# 1. QuestDB (Docker container, restart=always)
# 2. Mosquitto (MQTT broker local)
# 3. MQTT Hybrid Proxy (MITM TLS → local broker)
# 4. MQTT Ingestion (sensor data → QuestDB)
# 5. Data Retention (cleanup old data)
# 6. Supervisor Agent (trigger automation)
# 7. Camera Service (go2rtc manager + timelapse captures)
#
# Servicio ACTUALIZABLE:
# 8. Nuxt production server (web UI + API + WebSocket)

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "========================================"
echo "  SCHEDULE 4 REAL - FULL START"
echo "========================================"
echo ""

# Cargar variables de entorno
if [ -f ".env" ]; then
    set -a
    source <(grep -v '^#' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | sed 's/\r$//')
    set +a
    success "Variables de entorno cargadas"
else
    warning "Archivo .env no encontrado, usando valores por defecto"
fi

# Configuración - port defaults from .env
export NITRO_HOST=0.0.0.0
export NITRO_PORT=${API_PORT:-3000}
MQTT_PORT=${MQTT_PORT:-1883}
MQTT_LAN_PORT=${MQTT_LAN_PORT:-1884}
PROXY_PORT=${PROXY_PORT:-8883}
QUESTDB_USER=${QUESTDB_USER:-spider}
QUESTDB_PASSWORD=${QUESTDB_PASSWORD:-spider123}
QUESTDB_PG_PORT=${QUESTDB_PG_PORT:-8812}
QUESTDB_HTTP_PORT=${QUESTDB_HTTP_PORT:-9000}
QUESTDB_ILP_PORT=${QUESTDB_ILP_PORT:-9009}

mkdir -p logs

# Check Node.js version against .nvmrc
if [ -f ".nvmrc" ]; then
    REQUIRED_NODE=$(cat .nvmrc | tr -d '[:space:]')
    CURRENT_NODE=$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)
    if [ -n "$CURRENT_NODE" ] && [ "$CURRENT_NODE" -lt "$REQUIRED_NODE" ] 2>/dev/null; then
        warning "Node.js v${CURRENT_NODE} detected, v${REQUIRED_NODE}+ required (.nvmrc)"
        warning "Run: curl -fsSL https://deb.nodesource.com/setup_${REQUIRED_NODE}.x | bash - && apt-get install -y nodejs"
    fi
fi

echo ""
echo "── SERVICIOS VITALES ──────────────────"
echo ""

# ═══════════════════════════════════════════
# 1. QuestDB (Docker)
# ═══════════════════════════════════════════
info "Verificando QuestDB..."
EXPECTED_MOUNT="$SCRIPT_DIR/database/data"

# Check if container exists and verify its bind mount path matches current directory
NEEDS_RECREATE=false
if docker ps -a --filter name=s4r-questdb --format '{{.Names}}' 2>/dev/null | grep -q "s4r-questdb"; then
    CURRENT_MOUNT=$(docker inspect s4r-questdb --format '{{range .Mounts}}{{if eq .Destination "/var/lib/questdb"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
    if [ "$CURRENT_MOUNT" != "$EXPECTED_MOUNT" ] && [ -n "$CURRENT_MOUNT" ]; then
        warning "QuestDB bind mount mismatch!"
        warning "  Container mount: $CURRENT_MOUNT"
        warning "  Expected mount:  $EXPECTED_MOUNT"
        # Migrate data from old mount to new mount if needed
        if [ -d "$CURRENT_MOUNT/db" ] && [ ! -d "$EXPECTED_MOUNT/db" ]; then
            info "Migrating QuestDB data from old path to new path..."
            mkdir -p "$EXPECTED_MOUNT"
            cp -a "$CURRENT_MOUNT/"* "$EXPECTED_MOUNT/" 2>/dev/null || true
            success "Data migrated"
        fi
        info "Recreating container with correct path..."
        docker stop s4r-questdb 2>/dev/null || true
        docker rm s4r-questdb 2>/dev/null || true
        NEEDS_RECREATE=true
    fi
fi

if [ "$NEEDS_RECREATE" = "false" ] && docker ps --filter name=s4r-questdb --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    success "QuestDB ya está corriendo"
else
    if [ "$NEEDS_RECREATE" = "false" ]; then
        # Intentar arrancar container existente
        if docker start s4r-questdb 2>/dev/null; then
            success "QuestDB reiniciado"
            NEEDS_RECREATE=skip
        else
            NEEDS_RECREATE=true
        fi
    fi
    if [ "$NEEDS_RECREATE" = "true" ]; then
        # Crear nuevo container
        info "Creando container QuestDB..."
        mkdir -p database/data
        docker run -d \
            --name s4r-questdb \
            --restart=always \
            --log-opt max-size=10m --log-opt max-file=3 \
            -p ${QUESTDB_PG_PORT}:8812 -p ${QUESTDB_HTTP_PORT}:9000 -p ${QUESTDB_ILP_PORT}:9009 \
            -v "$EXPECTED_MOUNT:/var/lib/questdb" \
            -e QDB_PG_USER="$QUESTDB_USER" \
            -e QDB_PG_PASSWORD="$QUESTDB_PASSWORD" \
            -e QDB_TELEMETRY_ENABLED=false \
            questdb/questdb:latest
    fi
    # Esperar a que QuestDB esté listo
    for i in {1..15}; do
        # Port 9000 here is the container-internal port (always 9000 inside Docker, regardless of host mapping)
        if docker exec s4r-questdb curl -s http://localhost:9000/exec?query=SELECT+1 >/dev/null 2>&1; then
            success "QuestDB listo (ports ${QUESTDB_PG_PORT}/${QUESTDB_HTTP_PORT}/${QUESTDB_ILP_PORT})"
            break
        fi
        sleep 1
        if [ $i -eq 15 ]; then
            warning "QuestDB timeout, continuando..."
        fi
    done
fi

# ═══════════════════════════════════════════
# 2. Mosquitto (generate config from .env ports)
# ═══════════════════════════════════════════
info "Verificando Mosquitto..."

# Stop and disable any system-wide mosquitto.service that might be holding port
# ${MQTT_PORT}. This is the #1 cause of the PM2 "s4r-mosquitto errored" after a
# reboot: distros that install the mosquitto package leave mosquitto.service
# enabled, it claims port 1883 on boot, then PM2's broker fails to bind and
# loops into errored state.
if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet mosquitto.service 2>/dev/null; then
        warning "System mosquitto.service is running — stopping it so PM2 can own port ${MQTT_PORT}"
        systemctl stop mosquitto.service 2>/dev/null || true
    fi
    if systemctl is-enabled --quiet mosquitto.service 2>/dev/null; then
        info "Disabling system mosquitto.service so it doesn't grab port ${MQTT_PORT} on next boot"
        systemctl disable mosquitto.service 2>/dev/null || true
    fi
fi

# Generate mosquitto.conf from .env ports.
# Includes the websockets listener so the dashboard's /mqtt WS proxy works
# (the LiteSpeed reverse-proxy forwards /mqtt → port ${MQTT_WS_PORT:-9001}).
mkdir -p proxy/mosquitto_data
cat > proxy/mosquitto.conf << MOSQ_EOF
# Mosquitto Local Broker - Schedule 4 Real
# Auto-generated from .env ports

listener ${MQTT_PORT} 127.0.0.1
listener ${MQTT_LAN_PORT} 0.0.0.0

listener ${MQTT_WS_PORT:-9001} 0.0.0.0
protocol websockets

allow_anonymous true

log_type all
log_dest stdout

persistence true
persistence_location proxy/mosquitto_data/

retain_available true
MOSQ_EOF

# If mosquitto is already listening (probably PM2 restarted it for us) we leave
# it alone. Otherwise bring it up under PM2 so a crash auto-restarts.
if lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    success "Mosquitto ya está corriendo en puerto ${MQTT_PORT}"
else
    # Defensive: if a stale persistence file is corrupted, mosquitto crashes on
    # startup and PM2 will mark it errored after 16 restarts. Detect that case
    # by trying to start once in foreground (timeout 3s) and fall back to a
    # clean persistence dir if it failed.
    if ! timeout 3 mosquitto -c "$SCRIPT_DIR/proxy/mosquitto.conf" -v >/tmp/mosq-test.log 2>&1; then
        # If the failure mentions the persistence file, rotate it
        if grep -qiE "Unable to (re)?store|persistence|corrupt" /tmp/mosq-test.log; then
            warning "Mosquitto persistence DB looks corrupt — rotating it"
            mv proxy/mosquitto_data "proxy/mosquitto_data.broken-$(date +%s)" 2>/dev/null || true
            mkdir -p proxy/mosquitto_data
        fi
    fi
    # Clean any leftover errored entry first so PM2 doesn't reuse stale state
    pm2 delete s4r-mosquitto 2>/dev/null || true
    # Use --interpreter none so PM2 doesn't try to run mosquitto via node on
    # certain PM2 versions; --max-restarts buffers transient port races on boot.
    pm2 start mosquitto \
        --name s4r-mosquitto \
        --interpreter none \
        --cwd "$SCRIPT_DIR" \
        --max-restarts 50 \
        --restart-delay 2000 \
        --log ./logs/mosquitto.log \
        --error ./logs/mosquitto-error.log \
        -- -c "$SCRIPT_DIR/proxy/mosquitto.conf" \
        2>/dev/null
    # Wait up to 5s for it to bind — slow Pi boots sometimes take that long
    for i in 1 2 3 4 5; do
        if lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then break; fi
        sleep 1
    done
    if lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
        success "Mosquitto iniciado en puertos ${MQTT_PORT}/${MQTT_LAN_PORT}"
    else
        error "No se pudo iniciar Mosquitto — revisar logs/mosquitto-error.log"
        # Tail the error log so the failure cause shows up directly in install output
        if [ -f logs/mosquitto-error.log ]; then
            warning "Últimas líneas del error log:"
            tail -n 10 logs/mosquitto-error.log | sed 's/^/    /'
        fi
    fi
fi

# ═══════════════════════════════════════════
# 3. MQTT Hybrid Proxy
# ═══════════════════════════════════════════
info "Verificando MQTT Proxy..."
if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    success "MQTT Proxy ya está corriendo en puerto ${PROXY_PORT}"
else
    if [ -f "proxy/spiderproxy" ]; then
        # Modo público: binario compilado con certs embebidos
        chmod +x proxy/spiderproxy
        pm2 start "$SCRIPT_DIR/proxy/spiderproxy" \
            --name s4r-proxy \
            --cwd "$SCRIPT_DIR" \
            --log ./logs/proxy.log \
            --error ./logs/proxy-error.log \
            2>/dev/null
        sleep 3
        if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
            success "MQTT Proxy (binario) iniciado en puerto ${PROXY_PORT}"
        else
            warning "MQTT Proxy no arrancó (revisar logs/proxy.log)"
        fi
    elif [ -f "proxy/mqtt_hybrid_proxy.py" ] && [ -f "proxy/certs/client.pem" ]; then
        # Modo desarrollo: script Python con certs en archivos
        pm2 start "python3 $SCRIPT_DIR/proxy/mqtt_hybrid_proxy.py" \
            --name s4r-proxy \
            --cwd "$SCRIPT_DIR/proxy" \
            --log ./logs/proxy.log \
            --error ./logs/proxy-error.log \
            2>/dev/null
        sleep 3
        if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
            success "MQTT Proxy (python) iniciado en puerto ${PROXY_PORT}"
        else
            warning "MQTT Proxy no arrancó (revisar logs/proxy.log)"
        fi
    else
        warning "MQTT Proxy: no se encontró ni spiderproxy ni mqtt_hybrid_proxy.py+certs"
    fi
fi

echo ""
echo "── SERVICIOS PM2 ────────────────────────"
echo ""

# Limpiar procesos PM2 previos de s4r
info "Limpiando procesos PM2 previos..."
pm2 delete s4r-web s4r-ingest s4r-retention s4r-supervisor s4r-mosquitto s4r-proxy s4r-cameras s4r-tunnel 2>/dev/null || true
sleep 2

# ═══════════════════════════════════════════
# 4. MQTT Ingestion
# ═══════════════════════════════════════════
info "Iniciando MQTT Ingestion..."
pm2 start src/services/mqtt-ingestion.js \
    --name s4r-ingest \
    --cwd "$SCRIPT_DIR" \
    --max-memory-restart 256M \
    --log ./logs/ingest-out.log \
    --error ./logs/ingest-err.log

# ═══════════════════════════════════════════
# 5. Data Retention
# ═══════════════════════════════════════════
info "Iniciando Data Retention..."
pm2 start src/services/data-retention.js \
    --name s4r-retention \
    --cwd "$SCRIPT_DIR" \
    --max-memory-restart 128M \
    --log ./logs/retention.log \
    --error ./logs/retention-error.log

# ═══════════════════════════════════════════
# 6. Supervisor Agent
# ═══════════════════════════════════════════
info "Iniciando Supervisor Agent..."
pm2 start src/services/supervisor-agent.cjs \
    --name s4r-supervisor \
    --cwd "$SCRIPT_DIR" \
    --max-memory-restart 384M \
    --exp-backoff-restart-delay 1000 \
    --kill-timeout 5000 \
    --log ./logs/supervisor.log \
    --error ./logs/supervisor-errors.log

# ═══════════════════════════════════════════
# 7. Camera Service (go2rtc manager + timelapse)
# ═══════════════════════════════════════════
info "Iniciando Camera Service..."
pm2 start src/services/camera-service.cjs \
    --name s4r-cameras \
    --cwd "$SCRIPT_DIR" \
    --max-memory-restart 256M \
    --log ./logs/cameras.log \
    --error ./logs/cameras-error.log

# ═══════════════════════════════════════════
# 8. Tunnel Agent (anonymous relay proxy)
# ═══════════════════════════════════════════
if [ "${TUNNEL_ENABLED}" = "true" ]; then
    info "Iniciando Tunnel Agent..."
    pm2 start src/services/tunnel-agent.cjs \
        --name s4r-tunnel \
        --cwd "$SCRIPT_DIR" \
        --max-memory-restart 128M \
        --restart-delay 5000 \
        --log ./logs/tunnel.log \
        --error ./logs/tunnel-error.log
else
    info "Tunnel Agent desactivado (TUNNEL_ENABLED != true)"
fi

# ═══════════════════════════════════════════
# 9. Relay Node (decentralized network)
# ═══════════════════════════════════════════
if [ -f "data/relay/relay-config.json" ]; then
    RELAY_ENABLED=$(node -e "try{const c=require('./data/relay/relay-config.json');process.stdout.write(c.enabled?'true':'false')}catch{process.stdout.write('false')}" 2>/dev/null)
    if [ "$RELAY_ENABLED" = "true" ]; then
        info "Iniciando Relay Node..."
        pm2 start src/services/relay/index.cjs \
            --name s4r-relay \
            --cwd "$SCRIPT_DIR" \
            --max-memory-restart 256M \
            --restart-delay 5000 \
            --log ./logs/relay.log \
            --error ./logs/relay-error.log
    else
        info "Relay Node desactivado (enabled=false en relay-config.json)"
    fi
else
    info "Relay Node no configurado (sin data/relay/relay-config.json)"
fi

# ═══════════════════════════════════════════
# 10. Room Publisher (auto-publish rooms to trackers)
# ═══════════════════════════════════════════
if [ "${TUNNEL_ENABLED}" = "true" ]; then
    info "Iniciando Room Publisher..."
    pm2 start src/services/room-publisher.cjs \
        --name s4r-room-publisher \
        --cwd "$SCRIPT_DIR" \
        --log ./logs/room-publisher.log \
        --error ./logs/room-publisher-error.log
else
    info "Room Publisher desactivado (requires TUNNEL_ENABLED=true)"
fi

echo ""
echo "── APP WEB ──────────────────────────────"
echo ""

# ═══════════════════════════════════════════
# 8. Nuxt App (ACTUALIZABLE)
# ═══════════════════════════════════════════
if [ ! -f ".output/server/index.mjs" ]; then
    error "No se encontró .output/server/index.mjs"
    error "Ejecuta './compile.sh' primero"
    warning "Servicios vitales arrancados sin app web"
else
    # Verificar puerto libre
    if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
        warning "Puerto ${NITRO_PORT} en uso, liberando..."
        PORT_PIDS=$(lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t 2>/dev/null)
        for pid in $PORT_PIDS; do
            kill -15 $pid 2>/dev/null || true
        done
        sleep 2
    fi

    # Ensure user data directory exists (persists across updates)
    mkdir -p data/room3d/savegame

    info "Iniciando Nuxt production server..."
    pm2 start .output/server/index.mjs \
        --name s4r-web \
        --cwd "$SCRIPT_DIR" \
        --max-memory-restart 512M \
        --node-args="--max-old-space-size=512" \
        --env NITRO_HOST=0.0.0.0 \
        --env NITRO_PORT=${NITRO_PORT} \
        --log ./logs/app.log \
        --error ./logs/app-error.log

    # Esperar a que el servidor esté listo
    info "Esperando a que el servidor esté listo..."
    for i in {1..15}; do
        if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
            success "Servidor web listo en puerto ${NITRO_PORT}"
            break
        fi
        sleep 1
        if [ $i -eq 15 ]; then
            warning "Timeout esperando servidor, continuando..."
        fi
    done
fi

echo ""

# Ensure PM2 auto-starts on boot + save current process list
info "Configurando auto-inicio y guardando PM2..."
pm2 startup 2>/dev/null | grep -v "^\[" | bash 2>/dev/null || true
pm2 save
success "Configuración guardada (auto-inicio activo)"

echo ""

# Estado final
success "========================================"
success "  Todos los servicios iniciados"
success "========================================"
echo ""
pm2 list | grep s4r-
echo ""
info "Web UI:     http://0.0.0.0:${NITRO_PORT}"
info "QuestDB:    http://0.0.0.0:${QUESTDB_HTTP_PORT}"
info "MQTT LAN:   puerto ${MQTT_LAN_PORT}"
info "MITM TLS:   puerto ${PROXY_PORT}"
info "Logs:       pm2 logs"
info "Monitor:    pm2 monit"
info "Detener:    ./kill.sh"
echo ""

exit 0
