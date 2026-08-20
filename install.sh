#!/bin/bash
# PowerZoid Calendar — Script de instalación
# Uso: bash install.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UUID="powerzoid-calendar@cleal.cl"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/powerzoid-calendar"
DATA_DIR="$HOME/.local/share/powerzoid-calendar"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PowerZoid Calendar — Instalación"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# [1] Directorios
echo "[1/4] Creando directorios..."
mkdir -p "$BIN_DIR" "$SYSTEMD_DIR" "$CONFIG_DIR" "$DATA_DIR"

# [2] Daemon
echo "[2/4] Instalando daemon..."
cp "$SCRIPT_DIR/daemon/powerzoid-calendar-daemon.py" "$BIN_DIR/powerzoid-calendar-daemon.py"
chmod +x "$BIN_DIR/powerzoid-calendar-daemon.py"

cp "$SCRIPT_DIR/systemd/powerzoid-calendar.service" "$SYSTEMD_DIR/"
systemctl --user daemon-reload
systemctl --user enable powerzoid-calendar.service
systemctl --user restart powerzoid-calendar.service

# [3] Extensión GNOME
echo "[3/4] Instalando extensión GNOME Shell..."
mkdir -p "$EXT_DIR"
cp -r "$SCRIPT_DIR/extension/$UUID/." "$EXT_DIR/"

# [4] Activar extensión
echo "[4/4] Activando extensión..."
if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "  → Extensión activada"
else
    echo "  → La extensión se activará en el próximo inicio de sesión (Wayland)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✓ Instalación completada"
echo ""
echo "  Próximos pasos:"
echo "  1. Cierra sesión y vuelve a entrar (Wayland), si es la primera instalación"
echo "  2. Sigue el 'Paso 0' del README para crear tus credenciales OAuth"
echo "     en Google Cloud Console (Client ID + Client Secret)"
echo "  3. Clic derecho en '📅' en la barra → Configuración…"
echo "     → pega el Client ID/Secret → Guardar → 'Conectar con Google Calendar'"
echo ""
echo "  Estado del daemon:"
systemctl --user status powerzoid-calendar.service --no-pager -n 5 2>/dev/null || true
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
