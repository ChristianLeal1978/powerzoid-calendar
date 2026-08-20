#!/bin/bash
# PowerZoid Calendar — Desinstalación
# Uso: bash uninstall.sh

UUID="powerzoid-calendar@cleal.cl"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  PowerZoid Calendar — Desinstalación"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Desactivar extensión
gnome-extensions disable "$UUID" 2>/dev/null || true

# Detener y deshabilitar servicio
systemctl --user stop powerzoid-calendar.service 2>/dev/null || true
systemctl --user disable powerzoid-calendar.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/powerzoid-calendar.service"
systemctl --user daemon-reload

# Eliminar archivos (NO la config, token ni logs)
rm -f "$HOME/.local/bin/powerzoid-calendar-daemon.py"
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "  ✓ Desinstalado"
echo ""
echo "  Conservados (eliminar manualmente si quieres):"
echo "  - Config: $HOME/.config/powerzoid-calendar/config"
echo "  - Token:  $HOME/.config/powerzoid-calendar/token.json"
echo "  - Log:    $HOME/.local/share/powerzoid-calendar/calendar.log"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
