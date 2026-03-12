#!/bin/bash
# Schedule 4 Real - Wi-Fi Hotspot Setup for Raspberry Pi
#
# Turns your Pi into a Wi-Fi gateway for Spider Farmer GGS controllers.
# The Pi captures all MQTT traffic (port 8883) so devices auto-detect
# in the dashboard — no router NAT rules needed.
#
# Requirements:
#   - Raspberry Pi connected to router via Ethernet
#   - Built-in Wi-Fi (wlan0) available
#   - NetworkManager installed (default on Pi OS Bookworm+)
#
# Usage:
#   sudo bash setup-hotspot.sh
#   sudo bash setup-hotspot.sh --ssid MyGrow --password secretpass
#   sudo bash setup-hotspot.sh --remove    (undo everything)
#
# Author: Community contribution, improved by Ptakx (opengrow.pt)

set -e

# ─── Colors ──────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}  [OK]${NC} $1"; }
warning() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

HOTSPOT_CON_NAME="S4R-Hotspot"
HOTSPOT_SUBNET="192.168.10"
PROXY_PORT=8883

# ─── Parse arguments ─────────────────────────────────
SSID=""
PASSWORD=""
REMOVE=false
WIFI_IFACE=""
CHANNEL=6

while [[ $# -gt 0 ]]; do
    case "$1" in
        --ssid)     SSID="$2"; shift 2 ;;
        --password) PASSWORD="$2"; shift 2 ;;
        --channel)  CHANNEL="$2"; shift 2 ;;
        --iface)    WIFI_IFACE="$2"; shift 2 ;;
        --remove)   REMOVE=true; shift ;;
        -h|--help)
            echo "Usage: sudo bash setup-hotspot.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --ssid NAME       Wi-Fi network name (default: interactive prompt)"
            echo "  --password PASS   Wi-Fi password, min 8 chars (default: interactive prompt)"
            echo "  --channel NUM     Wi-Fi channel 1-11 (default: 6)"
            echo "  --iface NAME      Wi-Fi interface (default: auto-detect, usually wlan0)"
            echo "  --remove          Remove hotspot and iptables rules"
            echo "  -h, --help        Show this help"
            exit 0 ;;
        *) error "Unknown option: $1. Use --help for usage." ;;
    esac
done

# ─── Root check ──────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    error "This script requires root. Run with: sudo bash setup-hotspot.sh"
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}   ${BOLD}Wi-Fi Hotspot Setup${NC}                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}   ${DIM}GGS Controller Gateway for Raspberry Pi${NC}          ${GREEN}║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── Remove mode ─────────────────────────────────────
if $REMOVE; then
    info "Removing hotspot configuration..."

    # Remove NetworkManager connection
    if nmcli con show "$HOTSPOT_CON_NAME" &>/dev/null; then
        nmcli con down "$HOTSPOT_CON_NAME" 2>/dev/null || true
        nmcli con delete "$HOTSPOT_CON_NAME" 2>/dev/null || true
        success "Hotspot connection removed"
    else
        info "Hotspot connection not found (already removed?)"
    fi

    # Remove iptables rules
    WIFI_IFACE=${WIFI_IFACE:-wlan0}
    iptables -t nat -D PREROUTING -i "$WIFI_IFACE" -p tcp --dport $PROXY_PORT -j REDIRECT --to-ports $PROXY_PORT 2>/dev/null && \
        success "iptables redirect rule removed" || info "iptables rule not found"

    # Remove persistent sysctl
    if [ -f /etc/sysctl.d/90-s4r-hotspot.conf ]; then
        rm -f /etc/sysctl.d/90-s4r-hotspot.conf
        success "IP forwarding config removed"
    fi

    # Save iptables
    if command -v netfilter-persistent &>/dev/null; then
        netfilter-persistent save 2>/dev/null
        success "iptables rules saved"
    fi

    echo ""
    success "Hotspot removed. Reboot recommended."
    exit 0
fi

# ═════════════════════════════════════════════════════
# 1. System checks
# ═════════════════════════════════════════════════════
info "Checking system requirements..."

# NetworkManager
if ! command -v nmcli &>/dev/null; then
    info "Installing NetworkManager..."
    apt-get update -qq
    apt-get install -y network-manager >/dev/null 2>&1
    systemctl enable --now NetworkManager
fi
success "NetworkManager available"

# iptables
if ! command -v iptables &>/dev/null; then
    apt-get install -y iptables >/dev/null 2>&1
fi
success "iptables available"

# Detect Wi-Fi interface
if [ -z "$WIFI_IFACE" ]; then
    WIFI_IFACE=$(iw dev 2>/dev/null | awk '/Interface/{print $2}' | head -1)
    if [ -z "$WIFI_IFACE" ]; then
        # Fallback: look for wlan*
        WIFI_IFACE=$(ip link show | grep -oP 'wlan\d+' | head -1)
    fi
fi

if [ -z "$WIFI_IFACE" ]; then
    error "No Wi-Fi interface found. Is this a Raspberry Pi with built-in Wi-Fi?"
fi
success "Wi-Fi interface: $WIFI_IFACE"

# Detect Ethernet interface
ETH_IFACE=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'dev \K\S+' | head -1)
if [ -z "$ETH_IFACE" ]; then
    ETH_IFACE=$(ip link show | grep -oP '(eth|end|enp)\w+' | head -1)
fi

if [ -z "$ETH_IFACE" ]; then
    warning "No Ethernet interface detected. Make sure your Pi is connected via Ethernet cable!"
else
    # Check if Ethernet has an IP
    ETH_IP=$(ip -4 addr show "$ETH_IFACE" 2>/dev/null | grep -oP 'inet \K[0-9.]+' | head -1)
    if [ -n "$ETH_IP" ]; then
        success "Ethernet: $ETH_IFACE ($ETH_IP)"
    else
        warning "Ethernet interface $ETH_IFACE has no IP address. Is the cable connected?"
    fi
fi

# Check if wifi is blocked by rfkill
if command -v rfkill &>/dev/null; then
    if rfkill list wifi 2>/dev/null | grep -q "Soft blocked: yes"; then
        info "Wi-Fi is soft-blocked, unblocking..."
        rfkill unblock wifi
        sleep 1
    fi
fi

echo ""

# ═════════════════════════════════════════════════════
# 2. Get SSID and password
# ═════════════════════════════════════════════════════
if [ -z "$SSID" ]; then
    echo -ne "  Wi-Fi network name (SSID) [${BOLD}S4R-Grow${NC}]: "
    read SSID
    SSID=${SSID:-S4R-Grow}
fi

if [ -z "$PASSWORD" ]; then
    echo -ne "  Wi-Fi password (min 8 chars) [${BOLD}growroom1${NC}]: "
    read PASSWORD
    PASSWORD=${PASSWORD:-growroom1}
fi

if [ ${#PASSWORD} -lt 8 ]; then
    error "Password must be at least 8 characters (WPA2 requirement)"
fi

echo ""
info "Creating hotspot: ${BOLD}$SSID${NC} on ${BOLD}$WIFI_IFACE${NC} (channel $CHANNEL)"
echo ""

# ═════════════════════════════════════════════════════
# 3. Create the Wi-Fi hotspot
# ═════════════════════════════════════════════════════

# Remove existing hotspot if present
nmcli con delete "$HOTSPOT_CON_NAME" 2>/dev/null || true

# Create AP connection
nmcli con add type wifi ifname "$WIFI_IFACE" mode ap \
    con-name "$HOTSPOT_CON_NAME" \
    ssid "$SSID" \
    autoconnect yes
success "Hotspot connection created"

# Frequency: 2.4GHz band (required for GGS controllers — they don't support 5GHz)
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless.band bg
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless.channel "$CHANNEL"
success "Frequency: 2.4GHz, channel $CHANNEL"

# Disable Wi-Fi power management (crucial for AP stability)
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless.powersave 2
success "Wi-Fi power management disabled"

# Security: WPA2-PSK with AES, PMF disabled (IoT devices don't support it)
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.key-mgmt wpa-psk
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.psk "$PASSWORD"
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.proto rsn
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.group ccmp
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.pairwise ccmp
nmcli con modify "$HOTSPOT_CON_NAME" 802-11-wireless-security.pmf 0
success "Security: WPA2-AES, PMF disabled (IoT compatible)"

# IP addressing: shared mode (NM auto-runs dnsmasq for DHCP + DNS + MASQUERADE)
nmcli con modify "$HOTSPOT_CON_NAME" ipv4.method shared \
    ipv4.addresses "${HOTSPOT_SUBNET}.1/24"
success "Network: ${HOTSPOT_SUBNET}.0/24 (DHCP + DNS + NAT automatic)"

# Bring up the hotspot
nmcli con up "$HOTSPOT_CON_NAME"
success "Hotspot is UP"

# Now disable power save at the driver level too
iw dev "$WIFI_IFACE" set power_save off 2>/dev/null || true

echo ""

# ═════════════════════════════════════════════════════
# 4. Traffic redirection (iptables)
# ═════════════════════════════════════════════════════
info "Configuring traffic redirection..."

# Enable IP forwarding (persistent)
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/90-s4r-hotspot.conf
sysctl -w net.ipv4.ip_forward=1 >/dev/null
success "IP forwarding enabled (persistent)"

# Remove duplicate rules if they exist, then add
iptables -t nat -D PREROUTING -i "$WIFI_IFACE" -p tcp --dport $PROXY_PORT \
    -j REDIRECT --to-ports $PROXY_PORT 2>/dev/null || true

iptables -t nat -A PREROUTING -i "$WIFI_IFACE" -p tcp --dport $PROXY_PORT \
    -j REDIRECT --to-ports $PROXY_PORT
success "Port $PROXY_PORT redirect: $WIFI_IFACE -> local proxy"

# Make iptables rules persistent
if ! command -v netfilter-persistent &>/dev/null; then
    info "Installing iptables-persistent..."
    # Pre-answer debconf prompts to avoid interactive dialog
    echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
    echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1
fi
netfilter-persistent save 2>/dev/null
success "iptables rules saved (persist across reboots)"

echo ""

# ═════════════════════════════════════════════════════
# 5. Verification
# ═════════════════════════════════════════════════════
echo -e "${CYAN}── VERIFICATION ───────────────────────${NC}"
echo ""

# Check hotspot is active
if nmcli con show --active | grep -q "$HOTSPOT_CON_NAME"; then
    success "Hotspot active: $SSID"
else
    warning "Hotspot may not be active. Check: nmcli con show --active"
fi

# Check iptables rule
if iptables -t nat -L PREROUTING -n 2>/dev/null | grep -q "dpt:$PROXY_PORT"; then
    success "iptables redirect active for port $PROXY_PORT"
else
    warning "iptables rule not found"
fi

# Check IP forwarding
if [ "$(sysctl -n net.ipv4.ip_forward 2>/dev/null)" = "1" ]; then
    success "IP forwarding enabled"
else
    warning "IP forwarding may not be active"
fi

# Check if proxy is listening
if ss -tlnp 2>/dev/null | grep -q ":$PROXY_PORT "; then
    success "Proxy listening on port $PROXY_PORT"
else
    warning "No service on port $PROXY_PORT yet (run the installer if you haven't)"
fi

echo ""

# ═════════════════════════════════════════════════════
# Summary
# ═════════════════════════════════════════════════════
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}   ${BOLD}HOTSPOT SETUP COMPLETE${NC}                            ${GREEN}║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}How it works:${NC}"
echo -e "  Your Pi creates a Wi-Fi network that GGS controllers"
echo -e "  connect to. All MQTT traffic (port 8883) is automatically"
echo -e "  redirected to the local proxy — no router config needed."
echo ""
echo -e "  ${CYAN}Wi-Fi Network:${NC}"
echo -e "    SSID:      ${BOLD}$SSID${NC}"
echo -e "    Password:  ${BOLD}$PASSWORD${NC}"
echo -e "    Gateway:   ${BOLD}${HOTSPOT_SUBNET}.1${NC}"
echo -e "    Interface: ${BOLD}$WIFI_IFACE${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo -e "  1. On the GGS controller, connect to ${BOLD}$SSID${NC}"
echo -e "     ${DIM}(Hold the mode button 5s to enter Wi-Fi pairing mode,"
echo -e "      then use the Spider Farmer app to set the new network)${NC}"
echo -e "  2. The controller will appear in your dashboard automatically"
echo ""
echo -e "  ${CYAN}Useful commands:${NC}"
echo -e "    nmcli con show --active        ${DIM}Check hotspot status${NC}"
echo -e "    sudo bash setup-hotspot.sh --remove  ${DIM}Undo everything${NC}"
echo ""
echo -e "${DIM}────────────────────────────────────────────────────${NC}"
echo ""

exit 0
