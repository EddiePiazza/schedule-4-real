#!/bin/bash
# Schedule 4 Real - Iniciar solo servicios VITALES
#
# Servicios vitales:
# 1. QuestDB (Docker, restart=always)
# 2. Mosquitto (MQTT broker, puertos 1883/1884)
# 3. MQTT Hybrid Proxy (MITM TLS, puerto 8883)
# 4. MQTT Ingestion (sensores → QuestDB)
# 5. Data Retention (limpieza datos >90 días)
# 6. Supervisor Agent (automatización)
#
# NO arranca la app web (Nuxt). Para eso usa ./pm2-start.sh

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

# Cargar variables de entorno
if [ -f ".env" ]; then
    set -a
    source <(grep -v '^#' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | sed 's/\r$//')
    set +a
fi

# Port defaults from .env
MQTT_PORT=${MQTT_PORT:-1883}
MQTT_LAN_PORT=${MQTT_LAN_PORT:-1884}
PROXY_PORT=${PROXY_PORT:-8883}
QUESTDB_USER=${QUESTDB_USER:-spider}
QUESTDB_PASSWORD=${QUESTDB_PASSWORD:-spider123}
QUESTDB_PG_PORT=${QUESTDB_PG_PORT:-8812}
QUESTDB_HTTP_PORT=${QUESTDB_HTTP_PORT:-9000}
QUESTDB_ILP_PORT=${QUESTDB_ILP_PORT:-9009}

mkdir -p logs

echo ""
echo "========================================"
echo "  SERVICIOS VITALES - START"
echo "========================================"
echo ""

# ═══════════════════════════════════════════
# 1. QuestDB (Docker)
# ═══════════════════════════════════════════
info "Verificando QuestDB..."
if docker ps --filter name=s4r-questdb --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    success "QuestDB ya está corriendo"
else
    if docker start s4r-questdb 2>/dev/null; then
        success "QuestDB reiniciado"
    else
        info "Creando container QuestDB..."
        mkdir -p database/data
        docker run -d \
            --name s4r-questdb \
            --restart=always \
            -p ${QUESTDB_PG_PORT}:8812 -p ${QUESTDB_HTTP_PORT}:9000 -p ${QUESTDB_ILP_PORT}:9009 \
            -v "$SCRIPT_DIR/database/data:/var/lib/questdb" \
            -e QDB_PG_USER="$QUESTDB_USER" \
            -e QDB_PG_PASSWORD="$QUESTDB_PASSWORD" \
            -e QDB_TELEMETRY_ENABLED=false \
            questdb/questdb:latest
    fi
    for i in {1..15}; do
        # Port 9000 here is the container-internal port (always 9000 inside Docker, regardless of host mapping)
        if docker exec s4r-questdb curl -s http://localhost:9000/exec?query=SELECT+1 >/dev/null 2>&1; then
            success "QuestDB listo (${QUESTDB_PG_PORT}/${QUESTDB_HTTP_PORT}/${QUESTDB_ILP_PORT})"
            break
        fi
        sleep 1
        [ $i -eq 15 ] && warning "QuestDB timeout"
    done
fi

# ═══════════════════════════════════════════
# 2. Mosquitto
# ═══════════════════════════════════════════
info "Verificando Mosquitto..."
mkdir -p proxy/mosquitto_data
cat > proxy/mosquitto.conf << MOSQ_EOF
# Mosquitto Local Broker - Schedule 4 Real
# Auto-generated from .env ports

listener ${MQTT_PORT} 127.0.0.1
listener ${MQTT_LAN_PORT} 0.0.0.0

allow_anonymous true

log_type all
log_dest stdout

persistence true
persistence_location proxy/mosquitto_data/

retain_available true
MOSQ_EOF

if lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    success "Mosquitto ya está corriendo (${MQTT_PORT}/${MQTT_LAN_PORT})"
else
    pm2 start "mosquitto -c $SCRIPT_DIR/proxy/mosquitto.conf" \
        --name s4r-mosquitto \
        --cwd "$SCRIPT_DIR" \
        --log ./logs/mosquitto.log \
        --error ./logs/mosquitto-error.log \
        2>/dev/null
    sleep 1
    if lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
        success "Mosquitto iniciado (${MQTT_PORT}/${MQTT_LAN_PORT})"
    else
        error "No se pudo iniciar Mosquitto"
    fi
fi

# ═══════════════════════════════════════════
# 3. MQTT Hybrid Proxy
# ═══════════════════════════════════════════
info "Verificando MQTT Proxy..."
if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    success "MQTT Proxy ya está corriendo (${PROXY_PORT})"
else
    if [ -f "proxy/spiderproxy" ]; then
        chmod +x proxy/spiderproxy
        pm2 start "$SCRIPT_DIR/proxy/spiderproxy" \
            --name s4r-proxy \
            --cwd "$SCRIPT_DIR" \
            --log ./logs/proxy.log \
            --error ./logs/proxy-error.log \
            2>/dev/null
        sleep 3
        if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
            success "MQTT Proxy (binario) iniciado (${PROXY_PORT})"
        else
            warning "MQTT Proxy no arrancó (revisar logs/proxy.log)"
        fi
    elif [ -f "proxy/mqtt_hybrid_proxy.py" ] && [ -f "proxy/certs/client.pem" ]; then
        pm2 start "python3 $SCRIPT_DIR/proxy/mqtt_hybrid_proxy.py" \
            --name s4r-proxy \
            --cwd "$SCRIPT_DIR/proxy" \
            --log ./logs/proxy.log \
            --error ./logs/proxy-error.log \
            2>/dev/null
        sleep 3
        if lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
            success "MQTT Proxy (python) iniciado (${PROXY_PORT})"
        else
            warning "MQTT Proxy no arrancó (revisar logs/proxy.log)"
        fi
    else
        warning "MQTT Proxy: no se encontró ni spiderproxy ni mqtt_hybrid_proxy.py+certs"
    fi
fi

echo ""

# ═══════════════════════════════════════════
# 4-6. Servicios PM2 vitales
# ═══════════════════════════════════════════
info "Verificando servicios PM2 vitales..."

# Ingestion
if pm2 describe s4r-ingest >/dev/null 2>&1; then
    success "s4r-ingest ya está corriendo"
else
    pm2 start src/services/mqtt-ingestion.js \
        --name s4r-ingest \
        --cwd "$SCRIPT_DIR" \
        --max-memory-restart 256M \
        --log ./logs/ingest-out.log \
        --error ./logs/ingest-err.log
    success "s4r-ingest iniciado"
fi

# Retention
if pm2 describe s4r-retention >/dev/null 2>&1; then
    success "s4r-retention ya está corriendo"
else
    pm2 start src/services/data-retention.js \
        --name s4r-retention \
        --cwd "$SCRIPT_DIR" \
        --max-memory-restart 128M \
        --log ./logs/retention.log \
        --error ./logs/retention-error.log
    success "s4r-retention iniciado"
fi

# Supervisor
if pm2 describe s4r-supervisor >/dev/null 2>&1; then
    success "s4r-supervisor ya está corriendo"
else
    pm2 start src/services/supervisor-agent.cjs \
        --name s4r-supervisor \
        --cwd "$SCRIPT_DIR" \
        --max-memory-restart 256M \
        --log ./logs/supervisor.log \
        --error ./logs/supervisor-errors.log
    success "s4r-supervisor iniciado"
fi

pm2 save 2>/dev/null

echo ""
success "========================================"
success "  Servicios vitales activos"
success "========================================"
echo ""
pm2 list | grep s4r-
echo ""
info "Detener vitales: ./stop-vital.sh"
info "Arrancar todo:   ./pm2-start.sh"
echo ""

exit 0
