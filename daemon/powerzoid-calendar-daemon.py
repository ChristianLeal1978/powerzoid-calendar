#!/usr/bin/env python3
"""
PowerZoid Calendar — Daemon de integración con Google Calendar
Puerto HTTP: 6793

Autentica vía OAuth 2.0 (flujo "installed app" con redirect loopback),
sondea Google Calendar y expone el próximo evento (o el que está en curso)
en /status para que la extensión GNOME lo consuma.

Config:  ~/.config/powerzoid-calendar/config       (client_id, client_secret, ...)
Token:   ~/.config/powerzoid-calendar/token.json
Log:     ~/.local/share/powerzoid-calendar/calendar.log
Status:  ~/.local/share/powerzoid-calendar/status.json
"""

import json
import os
import re
import threading
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs, quote
import urllib.request
import urllib.error

# ─────────────────────────────────────────────
# Rutas y constantes
# ─────────────────────────────────────────────
HOME        = Path.home()
CONFIG_DIR  = HOME / ".config/powerzoid-calendar"
CONFIG_FILE = CONFIG_DIR / "config"
TOKEN_FILE  = CONFIG_DIR / "token.json"
LOG_FILE    = HOME / ".local/share/powerzoid-calendar/calendar.log"
STATUS_FILE = HOME / ".local/share/powerzoid-calendar/status.json"

PORT           = 6793
REDIRECT_URI   = f"http://127.0.0.1:{PORT}/oauth/callback"
AUTH_ENDPOINT  = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
SCOPE          = "https://www.googleapis.com/auth/calendar.readonly"
API_BASE       = "https://www.googleapis.com/calendar/v3"

DEFAULT_POLL_INTERVAL  = 120   # segundos entre sondeos a Google
DEFAULT_LOOKAHEAD_DAYS = 14
MIN_POLL_INTERVAL      = 30

MEETING_DOMAINS = [
    (re.compile(r'meet\.google\.com'),        'Google Meet'),
    (re.compile(r'zoom\.us'),                 'Zoom'),
    (re.compile(r'teams\.microsoft\.com'),    'Microsoft Teams'),
    (re.compile(r'webex\.com'),               'Webex'),
    (re.compile(r'meet\.jit\.si'),            'Jitsi Meet'),
    (re.compile(r'whereby\.com'),             'Whereby'),
    (re.compile(r'gotomeeting\.com'),         'GoToMeeting'),
    (re.compile(r'chime\.aws'),               'Amazon Chime'),
]
URL_RE = re.compile(r'https?://[^\s<>")\]]+')

# ─────────────────────────────────────────────
# Estado global
# ─────────────────────────────────────────────
_status: dict = {
    "state":       "starting",   # starting|no_config|no_auth|ok|empty|error|disconnected
    "event":       None,
    "upcoming":    [],
    "auth_url":    None,
    "last_update": None,
    "error":       None,
}
_lock             = threading.Lock()
_colors_cache     = None
_auth_opened_once = False
_pending_state    = None
_pending_auth_url = None


# ─────────────────────────────────────────────
# Utilidades básicas
# ─────────────────────────────────────────────

def log(msg: str) -> None:
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}\n"
    try:
        with open(LOG_FILE, "a") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="", flush=True)


def set_status(**kwargs) -> None:
    with _lock:
        _status.update(kwargs)
    save_status()


def save_status() -> None:
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        data = dict(_status)
    try:
        with open(STATUS_FILE, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        log(f"  [status] Error guardando: {e}")


def read_config() -> dict:
    cfg: dict = {}
    if not CONFIG_FILE.exists():
        return cfg
    try:
        for raw in CONFIG_FILE.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    except Exception:
        pass
    return cfg


# ─────────────────────────────────────────────
# HTTP genérico (stdlib, sin dependencias externas)
# ─────────────────────────────────────────────

def _http_call(method: str, url: str, data: dict | None = None,
                headers: dict | None = None, form: bool = False):
    headers = dict(headers or {})
    body = None
    if data is not None:
        if form:
            body = urlencode(data).encode()
            headers.setdefault("Content-Type", "application/x-www-form-urlencoded")
        else:
            body = json.dumps(data).encode()
            headers.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())


def api_get(access_token: str, url: str, params: dict | None = None):
    if params:
        url = f"{url}?{urlencode(params)}"
    return _http_call("GET", url, headers={"Authorization": f"Bearer {access_token}"})


# ─────────────────────────────────────────────
# OAuth 2.0
# ─────────────────────────────────────────────

def load_token() -> dict | None:
    try:
        return json.loads(TOKEN_FILE.read_text())
    except Exception:
        return None


def save_token(tok: dict) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(tok, indent=2))
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except Exception:
        pass


def build_auth_url(cfg: dict, force_new: bool = False) -> str:
    """Genera la URL de autorización. Reutiliza el `state` pendiente entre
    sondeos para no invalidar una pestaña de Google que el usuario todavía
    está completando; solo se fuerza un `state` nuevo cuando el usuario
    inicia explícitamente una reconexión."""
    global _pending_state, _pending_auth_url
    if not force_new and _pending_auth_url and _pending_state:
        return _pending_auth_url
    _pending_state = f"pzc-{int(time.time())}"
    params = {
        "client_id":             cfg["client_id"],
        "redirect_uri":          REDIRECT_URI,
        "response_type":         "code",
        "scope":                 SCOPE,
        "access_type":           "offline",
        "prompt":                "consent",
        "include_granted_scopes": "true",
        "state":                 _pending_state,
    }
    _pending_auth_url = f"{AUTH_ENDPOINT}?{urlencode(params)}"
    return _pending_auth_url


def _clear_pending_auth() -> None:
    global _pending_state, _pending_auth_url
    _pending_state    = None
    _pending_auth_url = None


def exchange_code(cfg: dict, code: str) -> dict:
    data = {
        "code":          code,
        "client_id":     cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "redirect_uri":  REDIRECT_URI,
        "grant_type":    "authorization_code",
    }
    tok = _http_call("POST", TOKEN_ENDPOINT, data=data, form=True)
    tok["obtained_at"] = time.time()
    save_token(tok)
    _clear_pending_auth()
    return tok


def refresh_access_token(cfg: dict, tok: dict) -> dict:
    data = {
        "refresh_token": tok["refresh_token"],
        "client_id":     cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "grant_type":    "refresh_token",
    }
    fresh = _http_call("POST", TOKEN_ENDPOINT, data=data, form=True)
    tok.update(fresh)
    tok["obtained_at"] = time.time()
    save_token(tok)
    return tok


def get_access_token(cfg: dict) -> str | None:
    tok = load_token()
    if not tok or "refresh_token" not in tok:
        return None
    expires_in = tok.get("expires_in", 3600)
    obtained   = tok.get("obtained_at", 0)
    if time.time() > obtained + expires_in - 90:
        tok = refresh_access_token(cfg, tok)
    return tok["access_token"]


def _is_invalid_grant(e: Exception) -> bool:
    """True solo si Google rechazó el refresh_token (revocado/expirado).
    Fallos transitorios de red (DNS, timeout, sin conectividad al arrancar)
    no deben forzar una reconexión manual del usuario."""
    return isinstance(e, urllib.error.HTTPError) and e.code in (400, 401)


def maybe_auto_open_browser(url: str) -> None:
    """Abre el navegador una sola vez por ejecución del daemon."""
    global _auth_opened_once
    if _auth_opened_once:
        return
    _auth_opened_once = True
    try:
        webbrowser.open(url)
        log("  [auth] Navegador abierto automáticamente para autorizar")
    except Exception as e:
        log(f"  [auth] No se pudo abrir el navegador automáticamente: {e}")


# ─────────────────────────────────────────────
# Google Calendar
# ─────────────────────────────────────────────

def get_colors(access_token: str) -> dict:
    global _colors_cache
    if _colors_cache:
        return _colors_cache
    _colors_cache = api_get(access_token, f"{API_BASE}/colors")
    return _colors_cache


def fetch_calendars(access_token: str, cfg: dict) -> list[dict]:
    wanted = [c.strip() for c in cfg.get("calendars", "primary").split(",") if c.strip()]
    data = api_get(access_token, f"{API_BASE}/users/me/calendarList", params={
        "minAccessRole": "reader",
        "fields":        "items(id,summary,backgroundColor,selected,primary)",
    })
    items = data.get("items", [])

    if wanted and wanted != ["all"]:
        by_id  = {c["id"]: c for c in items}
        result = []
        for cid in wanted:
            if cid == "primary":
                prim = next((c for c in items if c.get("primary")), None)
                if prim:
                    result.append(prim)
            elif cid in by_id:
                result.append(by_id[cid])
        return result or items[:1]

    return [c for c in items if c.get("selected", True)]


def _self_declined(ev: dict) -> bool:
    for a in ev.get("attendees", []):
        if a.get("self") and a.get("responseStatus") == "declined":
            return True
    return False


def fetch_events(access_token: str, calendar: dict, lookahead_days: int) -> list[tuple]:
    now      = datetime.now(timezone.utc)
    time_min = now.isoformat()
    time_max = (now + timedelta(days=lookahead_days)).isoformat()
    data = api_get(access_token, f"{API_BASE}/calendars/{quote(calendar['id'], safe='')}/events", params={
        "timeMin":      time_min,
        "timeMax":      time_max,
        "singleEvents": "true",
        "orderBy":      "startTime",
        "maxResults":   "10",
        "fields":       "items(id,summary,description,location,start,end,status,colorId,"
                        "hangoutLink,conferenceData,attendees,organizer,htmlLink)",
    })
    events = []
    for ev in data.get("items", []):
        if ev.get("status") == "cancelled":
            continue
        if _self_declined(ev):
            continue
        events.append((calendar, ev))
    return events


def _parse_dt(d: dict) -> datetime | None:
    if "dateTime" in d:
        return datetime.fromisoformat(d["dateTime"].replace("Z", "+00:00"))
    if "date" in d:
        y, m, dd  = map(int, d["date"].split("-"))
        local_tz  = datetime.now().astimezone().tzinfo
        return datetime(y, m, dd, tzinfo=local_tz)
    return None


def extract_meeting(ev: dict) -> tuple[str | None, str | None]:
    conf = ev.get("conferenceData")
    if conf:
        for ep in conf.get("entryPoints", []):
            if ep.get("entryPointType") == "video" and ep.get("uri"):
                provider = (conf.get("conferenceSolution") or {}).get("name") or "Videoconferencia"
                return ep["uri"], provider
    if ev.get("hangoutLink"):
        return ev["hangoutLink"], "Google Meet"

    haystack = " ".join(filter(None, [ev.get("location"), ev.get("description")]))
    for m in URL_RE.finditer(haystack):
        url = m.group(0).rstrip('.,;)')
        for rx, name in MEETING_DOMAINS:
            if rx.search(url):
                return url, name
    return None, None


def build_event_payload(calendar: dict, ev: dict, colors: dict) -> dict:
    start_dt = _parse_dt(ev["start"])
    end_dt   = _parse_dt(ev["end"])
    all_day  = "date" in ev["start"]
    now      = datetime.now(timezone.utc)

    color_id = ev.get("colorId")
    if color_id and colors.get("event", {}).get(color_id):
        color = colors["event"][color_id]["background"]
    else:
        color = calendar.get("backgroundColor") or "#4285F4"

    meeting_url, meeting_provider = extract_meeting(ev)
    organizer = ev.get("organizer") or {}

    return {
        "id":               ev["id"],
        "summary":          ev.get("summary") or "(Sin título)",
        "description":      (ev.get("description") or "").strip(),
        "location":         ev.get("location") or "",
        "start":            start_dt.isoformat(),
        "end":              end_dt.isoformat(),
        "all_day":          all_day,
        "is_ongoing":       start_dt <= now < end_dt,
        "color":            color,
        "calendar_summary": calendar.get("summary") or "",
        "organizer":        organizer.get("displayName") or organizer.get("email") or "",
        "attendees_count":  len(ev.get("attendees") or []),
        "meeting_url":      meeting_url,
        "meeting_provider": meeting_provider,
        "html_link":        ev.get("htmlLink") or "",
    }


# ─────────────────────────────────────────────
# Ciclo de sondeo
# ─────────────────────────────────────────────

def poll_once() -> None:
    cfg = read_config()

    if not cfg.get("client_id") or not cfg.get("client_secret"):
        set_status(state="no_config", event=None, auth_url=None, error=None)
        return

    tok = load_token()
    if not tok:
        url = build_auth_url(cfg)
        set_status(state="no_auth", event=None, auth_url=url, error=None)
        maybe_auto_open_browser(url)
        return

    try:
        access_token = get_access_token(cfg)
    except Exception as e:
        if _is_invalid_grant(e):
            log(f"  [auth] Google rechazó el token, reconexión requerida: {e}")
            try:
                TOKEN_FILE.unlink()
            except Exception:
                pass
            url = build_auth_url(cfg)
            set_status(state="no_auth", event=None, auth_url=url, error=str(e))
        else:
            log(f"  [auth] Refresh falló temporalmente, se reintentará: {e}")
            set_status(state="error", error=f"Sin conexión: {e}")
        return

    if not access_token:
        url = build_auth_url(cfg)
        set_status(state="no_auth", event=None, auth_url=url, error=None)
        return

    try:
        colors    = get_colors(access_token)
        calendars = fetch_calendars(access_token, cfg)
        lookahead = int(cfg.get("lookahead_days", DEFAULT_LOOKAHEAD_DAYS))

        pairs = []
        for cal in calendars:
            pairs.extend(fetch_events(access_token, cal, lookahead))

        now        = datetime.now(timezone.utc)
        candidates = []
        for cal, ev in pairs:
            end_dt = _parse_dt(ev["end"])
            if end_dt and end_dt >= now:
                candidates.append((cal, ev, _parse_dt(ev["start"])))
        candidates.sort(key=lambda t: t[2])

        event_payload = None
        upcoming      = []
        if candidates:
            top_cal, top_ev, _ = candidates[0]
            event_payload = build_event_payload(top_cal, top_ev, colors)
            for cal, ev, _ in candidates[1:5]:
                upcoming.append(build_event_payload(cal, ev, colors))

        set_status(
            state=("ok" if event_payload else "empty"),
            event=event_payload,
            upcoming=upcoming,
            last_update=now.isoformat(),
            error=None,
            auth_url=None,
        )
        log(f"Poll OK — {('Próximo: ' + event_payload['summary']) if event_payload else 'sin eventos próximos'}")

    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        log(f"  [poll] HTTPError {e.code}: {body[:200]}")
        if e.code == 401:
            try:
                TOKEN_FILE.unlink()
            except Exception:
                pass
            url = build_auth_url(cfg)
            set_status(state="no_auth", event=None, auth_url=url, error="Token inválido, reconecta tu cuenta")
        else:
            set_status(state="error", error=f"HTTP {e.code}")
    except Exception as e:
        log(f"  [poll] Error: {e}")
        set_status(state="error", error=str(e))


def poll_loop() -> None:
    while True:
        try:
            poll_once()
        except Exception as e:
            log(f"  [loop] Error inesperado: {e}")
            set_status(state="error", error=str(e))
        cfg      = read_config()
        interval = max(MIN_POLL_INTERVAL, int(cfg.get("poll_interval", DEFAULT_POLL_INTERVAL) or DEFAULT_POLL_INTERVAL))
        time.sleep(interval)


# ─────────────────────────────────────────────
# Servidor HTTP
# ─────────────────────────────────────────────

CALLBACK_OK = """<!doctype html><meta charset="utf-8">
<title>PowerZoid Calendar</title>
<body style="font-family:sans-serif;background:#1e1e1e;color:#eee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
<h2>✓ Cuenta conectada</h2>
<p>Ya puedes cerrar esta pestaña y volver a GNOME.</p>
</div></body>"""

CALLBACK_ERR = """<!doctype html><meta charset="utf-8">
<title>PowerZoid Calendar</title>
<body style="font-family:sans-serif;background:#1e1e1e;color:#eee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;">
<h2>❌ No se pudo conectar</h2>
<p>{msg}</p>
<p>Cierra esta pestaña y vuelve a intentarlo desde el menú de la extensión.</p>
</div></body>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args) -> None:
        pass

    def _json(self, code: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, code: int, html: str) -> None:
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/status":
            with _lock:
                data = dict(_status)
            self._json(200, data)

        elif parsed.path == "/ping":
            self._json(200, {"ok": True, "port": PORT})

        elif parsed.path == "/oauth/callback":
            qs = parse_qs(parsed.query)
            if "error" in qs:
                self._html(200, CALLBACK_ERR.format(msg=qs["error"][0]))
                return
            code  = qs.get("code", [None])[0]
            state = qs.get("state", [None])[0]
            if not code or (_pending_state and state != _pending_state):
                self._html(400, CALLBACK_ERR.format(msg="Código o estado inválido"))
                return
            try:
                cfg = read_config()
                exchange_code(cfg, code)
                self._html(200, CALLBACK_OK)
                threading.Thread(target=poll_once, daemon=True).start()
            except Exception as e:
                log(f"  [oauth] Error intercambiando código: {e}")
                self._html(500, CALLBACK_ERR.format(msg=str(e)))

        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path == "/refresh":
            threading.Thread(target=poll_once, daemon=True).start()
            self._json(202, {"status": "actualizando"})

        elif self.path == "/auth/start":
            cfg = read_config()
            if not cfg.get("client_id") or not cfg.get("client_secret"):
                self._json(400, {"error": "Falta client_id/client_secret en la configuración"})
                return
            url = build_auth_url(cfg, force_new=True)
            set_status(state="no_auth", auth_url=url)
            try:
                webbrowser.open(url)
                opened = True
            except Exception:
                opened = False
            self._json(200, {"opened": opened, "url": url})

        elif self.path == "/auth/reset":
            try:
                TOKEN_FILE.unlink()
            except Exception:
                pass
            global _colors_cache
            _colors_cache = None
            _clear_pending_auth()
            set_status(state="no_config" if not read_config().get("client_id") else "no_auth",
                       event=None, auth_url=None, error=None)
            self._json(200, {"status": "desconectado"})

        else:
            self._json(404, {"error": "not found"})


# ─────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────

def main() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    if STATUS_FILE.exists():
        try:
            prev = json.loads(STATUS_FILE.read_text())
            with _lock:
                _status.update(prev)
        except Exception:
            pass

    log(f"PowerZoid Calendar Daemon v1.0 — puerto {PORT}")
    log(f"Config: {CONFIG_FILE}")

    cfg = read_config()
    if cfg.get("client_id") and cfg.get("client_secret"):
        log("  Credenciales OAuth: configuradas ✓")
    else:
        log("  Credenciales OAuth: NO configuradas — configúralas desde el menú de la extensión")

    t = threading.Thread(target=poll_loop, daemon=True)
    t.start()

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    log(f"HTTP escuchando en localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Daemon detenido por usuario")


if __name__ == "__main__":
    main()
