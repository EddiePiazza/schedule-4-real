#!/bin/bash
# Schedule 4 Real - Detener solo servicios VITALES
#
# Detiene:
# 1. Supervisor Agent
# 2. Data Retention
# 3. MQTT Ingestion
# 4. MQTT Hybrid Proxy
# 5. Mosquitto
# 6. QuestDB (Docker stop, NO rm)
#
# NO toca la app web (Nuxt). Para eso usa ./kill.sh app

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Port defaults
MQTT_PORT=${MQTT_PORT:-1883}
PROXY_PORT=${PROXY_PORT:-8883}

echo ""
echo "========================================"
echo "  SERVICIOS VITALES - STOP"
echo "========================================"
echo ""

# ═══════════════════════════════════════════
# 1-3. Servicios PM2 vitales
# ═══════════════════════════════════════════
info "Deteniendo servicios PM2 vitales..."
pm2 delete s4r-ingest s4r-retention s4r-supervisor s4r-mosquitto s4r-proxy 2>/dev/null || true
sleep 1
success "PM2 vitales detenidos"

# Kill any orphan mosquitto/proxy not managed by PM2
info "Limpiando procesos huérfanos..."
PROXY_PIDS=$(lsof -Pi :${PROXY_PORT} -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$PROXY_PIDS" ]; then
    for pid in $PROXY_PIDS; do
        kill -15 $pid 2>/dev/null || true
    done
    sleep 1
    success "MQTT Proxy detenido"
fi

MOSQUITTO_PIDS=$(lsof -Pi :${MQTT_PORT} -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$MOSQUITTO_PIDS" ]; then
    for pid in $MOSQUITTO_PIDS; do
        kill -15 $pid 2>/dev/null || true
    done
    sleep 1
    success "Mosquitto detenido"
fi

# ═══════════════════════════════════════════
# 6. QuestDB (Docker stop, mantiene datos)
# ═══════════════════════════════════════════
info "Deteniendo QuestDB..."
if docker ps --filter name=s4r-questdb --format '{{.Status}}' 2>/dev/null | grep -q "Up"; then
    docker stop s4r-questdb 2>/dev/null
    success "QuestDB detenido (datos preservados)"
else
    success "QuestDB no estaba corriendo"
fi

echo ""

pm2 save 2>/dev/null

success "========================================"
success "  Servicios vitales detenidos"
success "========================================"
echo ""
info "La app web (si estaba activa) sigue corriendo"
info "Reiniciar vitales: ./start-vital.sh"
info "Detener todo:      ./kill.sh"
echo ""

exit 0
