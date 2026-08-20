# PowerZoid Calendar — GNOME Shell Extension

Muestra tu próximo evento (o el que está en curso) de Google Calendar en la barra superior: hora, título y el mismo color que le diste en el calendario.

```
🔵 en 12 min · Daily con el equipo     ← próximo evento
🟢 Ahora · Revisión de PRs             ← evento en curso
📅 Sin eventos                         ← agenda libre
```

- **Hover** sobre el indicador → tarjeta con hora, ubicación, descripción y, si es una videoconferencia, botones para **unirse** o **copiar el enlace**.
- **Clic** (izquierdo o derecho) → menú con los mismos detalles, alineación en la barra y tamaño de letra.
- **Notificación** 10 minutos antes del evento (configurable), con acciones "Unirse" / "Copiar enlace" si hay videollamada.

---

## Arquitectura

```
Google Calendar API ──────── daemon:6793 ──────── extensión GNOME
                                  │
                          ~/.config/powerzoid-calendar/
                          (config, token.json)
```

- **Daemon Python** (`~/.local/bin/powerzoid-calendar-daemon.py`): autentica con Google vía OAuth 2.0, sondea Calendar API cada 2 minutos (configurable) y expone el próximo evento en `localhost:6793/status`. Sin dependencias externas — solo la biblioteca estándar de Python 3.
- **Extensión GNOME**: consulta el daemon cada 20 segundos y actualiza la barra, el tooltip y las notificaciones.

---

## Instalación

### Paso 0 — Crear credenciales OAuth en Google Cloud Console

Es indispensable crear tus propias credenciales (gratis, 5 minutos). Google no permite compartir credenciales entre usuarios distintos.

1. Ve a **https://console.cloud.google.com/** y crea un proyecto nuevo (o usa uno existente).
2. **APIs y servicios → Biblioteca** → busca **"Google Calendar API"** → **Habilitar**.
3. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Externo**
   - Completa el nombre de la app y tu correo de contacto
   - En **"Público" / "Estado de publicación"**, pulsa **Publicar app** (Production)
     > ⚠️ **Importante:** si dejas la app en modo "Prueba" (Testing), Google expira el token cada **7 días** y tendrás que reconectar la cuenta cada semana. En "Producción", sin verificación, el token es de larga duración. Como el scope usado (`calendar.readonly`) es "sensible" pero no "restringido", **no requiere el proceso de verificación de Google** para publicarse — solo verás una advertencia de "app no verificada" al autorizar (ver Paso 2).
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo de aplicación: **Aplicación de escritorio**
   - Nombre: `PowerZoid Calendar` (o el que prefieras)
5. Copia el **Client ID** y el **Client Secret** que se generan.

### Paso 1 — Instalar

```bash
cd ~/Proyectos/powerzoid-calendar
bash install.sh
```

### Paso 2 — Conectar tu cuenta

1. Clic derecho en **📅** en la barra superior → **Configuración…**
2. Pega el **Client ID** y **Client Secret** del Paso 0 → **Guardar y reiniciar daemon**
3. Pulsa **🔐 Conectar con Google Calendar** — se abre el navegador
4. Verás **"Google no ha verificado esta app"** → clic en **Avanzado** → **Ir a PowerZoid Calendar (no seguro)**
   > Es la advertencia estándar para apps personales no verificadas por Google. Es tu propia app, con tus propias credenciales — es segura.
5. Inicia sesión y acepta el permiso de **"Ver los eventos de tu calendario"** (solo lectura)
6. La pestaña mostrará "✓ Cuenta conectada" — ciérrala y vuelve a GNOME

En unos segundos el próximo evento aparecerá en la barra.

---

## Menú de la extensión

```
Daily con el equipo
🕐  martes, 18 de agosto · 10:00 – 10:30
📍  Sala 4
🗓  Trabajo
🔗  Unirse · Google Meet
📋  Copiar enlace de la reunión
─────────────────────────────
🔄  Actualizar ahora
🌐  Abrir en Google Calendar
─────────────────────────────
Posición en barra ▸
─────────────────────────────
Tamaño: 13 px
A+   Aumentar letra
A−   Reducir letra
↺    Restablecer tamaño
─────────────────────────────
⚙  Configuración…
```

---

## Configuración disponible

En **Configuración…**:

- **Client ID / Client Secret** — credenciales OAuth (Paso 0)
- **Calendarios a incluir** — `primary` (solo el principal), `all` (todos los visibles) o una lista de IDs separados por coma
- **Avisar antes del evento (minutos)** — por defecto 10
- **Intervalo de sondeo a Google** — por defecto 120 segundos
- **Días de anticipación** — rango de búsqueda de eventos futuros, por defecto 14

---

## Resolución de problemas

### El daemon no responde

```bash
systemctl --user status powerzoid-calendar.service
journalctl --user -u powerzoid-calendar.service -n 50
systemctl --user restart powerzoid-calendar.service
```

### Ver el estado JSON en bruto

```bash
curl -s localhost:6793/status | python3 -m json.tool
```

### "invalid_grant" o pide reconectar la cuenta constantemente

Tu app OAuth sigue en modo "Prueba" en Google Cloud Console — publícala en producción (ver Paso 0, punto 3).

### No detecta el enlace de la videollamada

Se busca primero en los datos de conferencia de Google Calendar (Meet nativo o add-ons de Zoom/Teams) y, si no hay, en el campo de ubicación/descripción del evento. Si el enlace está en un formato no estándar, puedes copiarlo manualmente desde "Abrir en Google Calendar".

### Trigger de actualización manual desde terminal

```bash
curl -s -X POST localhost:6793/refresh
```

---

## Desinstalar

```bash
bash uninstall.sh
```

La config, el token OAuth y los logs se conservan por seguridad; elimínalos manualmente si quieres borrar todo rastro:

```bash
rm -rf ~/.config/powerzoid-calendar ~/.local/share/powerzoid-calendar
```

---

## Requisitos

- Fedora 44 / GNOME Shell 45–50
- Python 3 (incluido en Fedora)
- Cuenta de Google con Calendar
- Credenciales OAuth propias (Paso 0 — gratis)

---

## Privacidad

- El daemon solo solicita el scope de **solo lectura** `calendar.readonly` — no puede crear, editar ni borrar eventos.
- Las credenciales y el token se guardan localmente en `~/.config/powerzoid-calendar/` con permisos `600` (solo tu usuario).
- Ninguna llamada sale de tu equipo salvo hacia `googleapis.com` y `accounts.google.com`.

---

## Licencia

GPL-2.0
