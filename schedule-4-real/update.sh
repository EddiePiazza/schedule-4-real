#!/bin/bash
# Schedule 4 Real - Actualizar app web
#
# Descarga la última versión del paquete y actualiza SOLO la app web.
# Los servicios vitales (QuestDB, Mosquitto, Proxy, Ingestion, Retention, Supervisor)
# NO se detienen ni se modifican.
#
# Uso: ./update.sh

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Directorio del script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

DOWNLOAD_URL="https://schedule4real.com/dist/install/schedule-4-real.tar.gz"
TMP_FILE="/tmp/schedule-4-real-update.tar.gz"
TMP_DIR="/tmp/schedule-4-real-update"

echo ""
echo "========================================"
echo "  SCHEDULE 4 REAL - ACTUALIZAR APP"
echo "========================================"
echo ""

info "Servicios vitales NO se tocan"
echo ""

# ─── 1. Descargar nueva versión ───
info "Descargando última versión..."
if command -v curl &>/dev/null; then
    curl -L "$DOWNLOAD_URL" -o "$TMP_FILE" 2>/dev/null
else
    wget -O "$TMP_FILE" "$DOWNLOAD_URL" 2>/dev/null
fi

if [ ! -f "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    error "No se pudo descargar el paquete desde ${DOWNLOAD_URL}"
fi
success "Paquete descargado"

# ─── 2. Extraer solo .output/ y src/services/ ───
info "Extrayendo actualización..."
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
tar xzf "$TMP_FILE" -C "$TMP_DIR"
rm -f "$TMP_FILE"

EXTRACTED_DIR="${TMP_DIR}/schedule-4-real"
if [ ! -d "$EXTRACTED_DIR/.output" ]; then
    rm -rf "$TMP_DIR"
    error "El paquete no contiene .output/ - descarga corrupta"
fi
success "Paquete extraído"

echo ""

# ─── 3. Detener solo la app web ───
info "Deteniendo app web..."
pm2 delete s4r-web 2>/dev/null || true
sleep 1

# Cargar .env para saber el puerto
if [ -f ".env" ]; then
    set -a
    source <(grep -v '^#' .env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | sed 's/\r$//')
    set +a
fi
NITRO_PORT=${API_PORT:-3000}

# Liberar puerto si sigue ocupado
if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
    PORT_PIDS=$(lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t 2>/dev/null)
    for pid in $PORT_PIDS; do
        kill -15 $pid 2>/dev/null || true
    done
    sleep 1
fi
success "App web detenida"

# ─── 4. Reemplazar archivos ───
info "Actualizando archivos..."

# Reemplazar .output/
rm -rf .output
cp -r "$EXTRACTED_DIR/.output" ./
success "  .output/ actualizado"

# Actualizar servicios (si hay cambios)
if [ -d "$EXTRACTED_DIR/src/services" ]; then
    cp "$EXTRACTED_DIR/src/services/"* src/services/ 2>/dev/null
    success "  src/services/ actualizado"
fi

# Actualizar src/db/ (si hay cambios)
if [ -d "$EXTRACTED_DIR/src/db" ]; then
    cp "$EXTRACTED_DIR/src/db/"* src/db/ 2>/dev/null
    success "  src/db/ actualizado"
fi

# Actualizar scripts (excepto .env y certs)
for script in pm2-start.sh kill.sh update.sh; do
    if [ -f "$EXTRACTED_DIR/$script" ]; then
        cp "$EXTRACTED_DIR/$script" ./ 2>/dev/null
        chmod +x "$script"
    fi
done
success "  Scripts actualizados"

# Limpiar temporales
rm -rf "$TMP_DIR"

echo ""

# ─── 5. Reiniciar app web ───
info "Reiniciando app web..."
pm2 start .output/server/index.mjs \
    --name s4r-web \
    --cwd "$SCRIPT_DIR" \
    --max-memory-restart 512M \
    --node-args="--max-old-space-size=512" \
    --env NITRO_HOST=0.0.0.0 \
    --env NITRO_PORT=${NITRO_PORT} \
    --log ./logs/app.log \
    --error ./logs/app-error.log

# Esperar a que esté listo
for i in {1..15}; do
    if lsof -Pi :${NITRO_PORT} -sTCP:LISTEN -t >/dev/null 2>&1; then
        success "App web lista en puerto ${NITRO_PORT}"
        break
    fi
    sleep 1
    if [ $i -eq 15 ]; then
        warning "Timeout esperando app web"
    fi
done

pm2 save

echo ""

# ─── Resumen ───
success "========================================"
success "  Actualización completada"
success "========================================"
echo ""
info "App web actualizada y reiniciada"
info "Servicios vitales: sin cambios"
echo ""
pm2 list | grep s4r-
echo ""

exit 0
