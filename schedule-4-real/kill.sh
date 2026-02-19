#!/bin/bash
# Schedule 4 Real - Detener todos los servicios
#
# Uso:
#   ./kill.sh         - Detiene solo la app web (para updates)
#   ./kill.sh all     - Detiene TODO (vitales + app)

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Cargar variables de entorno
if [ -f ".env" ]; then
    set -a
    source <(grep -v '^#' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | sed 's/\r$//')
    set +a
fi

NITRO_PORT=${API_PORT:-3000}
MQTT_PORT=${MQTT_PORT:-1883}
PROXY_PORT=${PROXY_PORT:-8883}
QUESTDB_HTTP_PORT=${QUESTDB_HTTP_PORT:-9000}

# Modo: "all" detiene todo, sin argumentos solo detiene la app web
MODE=${1:-app}

echo "========================================"
if [ "$MODE" = "app" ]; then
    echo "  DETENIENDO APP WEB (vitales intactos)"
else
    echo "  DETENIENDO SCHEDULE 4 REAL (TODO)"
fi
echo "========================================"
echo ""

if [ "$MODE" = "app" ]; then
    # Solo detener la app web
    info "Deteniendo s4r-web..."
    pm2 delete s4r-web 2>/dev/null || true
    sleep 1

    # Verificar puerto
    if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
        PORT_PIDS=$(lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t 2>/dev/null)
        for pid in $PORT_PIDS; do
            kill -15 $pid 2>/dev/null || true
        done
    fi
    success "App web detenida (puerto ${NITRO_PORT} libre)"
    echo ""
    info "Servicios vitales siguen activos"
    pm2 list | grep s4r-
    echo ""
    exit 0
fi

# ── DETENER TODO ──

# Detener procesos PM2 de s4r
info "Deteniendo procesos PM2..."
pm2 delete s4r-web s4r-ingest s4r-retention s4r-supervisor s4r-mosquitto s4r-proxy s4r-cameras s4r-relay s4r-tunnel s4r-room-publisher 2>/dev/null || true
sleep 2
success "Procesos PM2 eliminados"

echo ""

# Kill any orphan mosquitto/proxy not managed by PM2
info "Deteniendo MQTT Proxy..."
PROXY_PIDS=$(lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PROXY_PIDS" ]; then
    for pid in $PROXY_PIDS; do
        kill -15 $pid 2>/dev/null || true
    done
    sleep 1
    success "MQTT Proxy detenido"
else
    success "MQTT Proxy ya detenido"
fi

info "Deteniendo Mosquitto..."
MOSQUITTO_PIDS=$(lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$MOSQUITTO_PIDS" ]; then
    for pid in $MOSQUITTO_PIDS; do
        kill -15 $pid 2>/dev/null || true
    done
    sleep 1
    success "Mosquitto detenido"
else
    success "Mosquitto ya detenido"
fi

# Detener QuestDB Docker (flush WAL first to avoid data loss)
info "Deteniendo QuestDB..."
if docker ps --filter name=s4r-questdb --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    # Flush WAL to commit pending data before stopping
    info "Flushing WAL data..."
    curl -s "http://127.0.0.1:${QUESTDB_HTTP_PORT}/exec?query=CHECKPOINT" >/dev/null 2>&1 || true
    sleep 2
    docker stop -t 30 s4r-questdb 2>/dev/null
    success "QuestDB detenido (WAL flushed)"
else
    success "QuestDB no estaba corriendo"
fi

echo ""

# Buscar procesos huérfanos de Node
info "Buscando procesos huérfanos..."
ORPHAN_PIDS=$(ps aux | grep -E "node.*(index\.mjs|mqtt-ingestion|data-retention|supervisor-agent|camera-service)" | grep -v grep | awk '{print $2}')

if [ -n "$ORPHAN_PIDS" ]; then
    warning "Procesos huérfanos encontrados:"
    for pid in $ORPHAN_PIDS; do
        echo "  - PID: $pid"
        kill -15 "$pid" 2>/dev/null || true
    done
    sleep 2
    success "Procesos huérfanos eliminados"
else
    success "No hay procesos huérfanos"
fi

echo ""

# Verificar puerto web libre
if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    warning "Puerto ${NITRO_PORT} aún en uso, forzando..."
    PORT_PIDS=$(lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t 2>/dev/null)
    for pid in $PORT_PIDS; do
        kill -9 $pid 2>/dev/null || true
    done
    sleep 1
fi
success "Puerto ${NITRO_PORT} libre"

echo ""

# Guardar estado PM2
pm2 save 2>/dev/null || true

success "========================================"
success "  Servicios detenidos correctamente"
success "========================================"
echo ""
info "Para reiniciar: ./pm2-start.sh"
echo ""

exit 0
