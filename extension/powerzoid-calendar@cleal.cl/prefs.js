/**
 * PowerZoid Calendar — Ventana de preferencias (GTK4 / Adwaita)
 * Acceso: clic derecho en el indicador → "Configuración…"
 *
 * NO usa GSettings. Lee y escribe directamente en:
 *   ~/.config/powerzoid-calendar/config
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'powerzoid-calendar', 'config',
]);
const CONFIG_DIR = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'powerzoid-calendar',
]);
const TOKEN_PATH = GLib.build_filenamev([
    GLib.get_home_dir(), '.config', 'powerzoid-calendar', 'token.json',
]);
const DAEMON_URL = 'http://127.0.0.1:6793';


// ─────────────────────────────────────────────────────────────────────────────
// Clase principal de preferencias
// ─────────────────────────────────────────────────────────────────────────────

export default class CalendarPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        window.set_default_size(640, 640);
        window.set_title('PowerZoid Calendar — Configuración');
        this._window = window;

        const cfg = this._readConfig();

        // ── Página ────────────────────────────────────────────────────────
        const page = new Adw.PreferencesPage({
            title: 'Configuración',
            icon_name: 'x-office-calendar-symbolic',
        });
        window.add(page);

        // ── Grupo: Cuenta de Google ──────────────────────────────────────
        const acctGroup = new Adw.PreferencesGroup({
            title: 'Cuenta de Google',
            description:
                'Requiere credenciales OAuth propias creadas en Google Cloud Console ' +
                '(gratis). Ver README para el paso a paso.',
        });
        page.add(acctGroup);

        const consoleLinkRow = new Adw.ActionRow({
            title:       'Abrir Google Cloud Console → Credenciales',
            subtitle:    'Crea un "ID de cliente OAuth" de tipo Aplicación de escritorio',
            activatable: true,
        });
        consoleLinkRow.add_suffix(new Gtk.Image({
            icon_name: 'external-link-symbolic', valign: Gtk.Align.CENTER, css_classes: ['dim-label'],
        }));
        consoleLinkRow.connect('activated', () => {
            Gio.AppInfo.launch_default_for_uri('https://console.cloud.google.com/apis/credentials', null);
        });
        acctGroup.add(consoleLinkRow);

        this._clientIdRow = new Adw.EntryRow({
            title: 'Client ID',
            text:  cfg.client_id || '',
            show_apply_button: true,
        });
        acctGroup.add(this._clientIdRow);

        this._clientSecretRow = new Adw.PasswordEntryRow({
            title: 'Client Secret',
            text:  cfg.client_secret || '',
            show_apply_button: true,
        });
        acctGroup.add(this._clientSecretRow);

        this._authStatusRow = new Adw.ActionRow({
            title:    'Estado de conexión',
            subtitle: this._describeAuthState(),
        });
        acctGroup.add(this._authStatusRow);

        const authRow = new Adw.ButtonRow({ title: '🔐  Conectar con Google Calendar' });
        authRow.connect('activated', () => this._connect());
        acctGroup.add(authRow);

        const disconnectRow = new Adw.ButtonRow({ title: 'Desconectar cuenta' });
        disconnectRow.add_css_class('destructive-action');
        disconnectRow.connect('activated', () => this._disconnect());
        acctGroup.add(disconnectRow);

        // ── Grupo: Calendarios ────────────────────────────────────────────
        const calGroup = new Adw.PreferencesGroup({
            title: 'Calendarios',
            description:
                '"primary" muestra solo tu calendario principal. Usa "all" para ' +
                'considerar todos los calendarios visibles, o una lista de IDs ' +
                'separados por coma (Ajustes de Google Calendar → cada calendario → ' +
                '"ID de calendario").',
        });
        page.add(calGroup);

        this._calendarsRow = new Adw.EntryRow({
            title: 'Calendarios a incluir',
            text:  cfg.calendars || 'primary',
            show_apply_button: true,
        });
        calGroup.add(this._calendarsRow);

        // ── Grupo: Notificaciones ─────────────────────────────────────────
        const notifGroup = new Adw.PreferencesGroup({ title: 'Notificaciones' });
        page.add(notifGroup);

        this._reminderRow = new Adw.SpinRow({
            title: 'Avisar antes del evento (minutos)',
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 60, step_increment: 1, value: cfg.reminder_minutes ? parseInt(cfg.reminder_minutes, 10) : 10 }),
        });
        notifGroup.add(this._reminderRow);

        // ── Grupo: Avanzado ───────────────────────────────────────────────
        const advGroup = new Adw.PreferencesGroup({ title: 'Avanzado' });
        page.add(advGroup);

        this._pollRow = new Adw.SpinRow({
            title: 'Intervalo de sondeo a Google (segundos)',
            subtitle: 'Cuánto espera el daemon entre consultas a la API de Calendar',
            adjustment: new Gtk.Adjustment({ lower: 30, upper: 900, step_increment: 30, value: cfg.poll_interval ? parseInt(cfg.poll_interval, 10) : 120 }),
        });
        advGroup.add(this._pollRow);

        this._lookaheadRow = new Adw.SpinRow({
            title: 'Días de anticipación',
            subtitle: 'Rango de búsqueda de eventos futuros',
            adjustment: new Gtk.Adjustment({ lower: 1, upper: 60, step_increment: 1, value: cfg.lookahead_days ? parseInt(cfg.lookahead_days, 10) : 14 }),
        });
        advGroup.add(this._lookaheadRow);

        // ── Botón de guardar ──────────────────────────────────────────────
        const saveGroup = new Adw.PreferencesGroup();
        page.add(saveGroup);

        const saveRow = new Adw.ButtonRow({ title: 'Guardar y reiniciar daemon' });
        saveRow.add_css_class('suggested-action');
        saveGroup.add(saveRow);
        saveRow.connect('activated', () => this._save());

        this._clientIdRow.connect('apply', () => this._save());
        this._clientSecretRow.connect('apply', () => this._save());
        this._calendarsRow.connect('apply', () => this._save());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Estado de conexión
    // ─────────────────────────────────────────────────────────────────────

    _describeAuthState() {
        const file = Gio.File.new_for_path(TOKEN_PATH);
        return file.query_exists(null)
            ? '✓ Cuenta conectada'
            : 'Sin conectar — ingresa Client ID/Secret y pulsa "Conectar"';
    }

    _refreshAuthStatus() {
        this._authStatusRow.set_subtitle(this._describeAuthState());
    }

    // ─────────────────────────────────────────────────────────────────────
    // Conectar / desconectar
    // ─────────────────────────────────────────────────────────────────────

    _connect() {
        const clientId     = this._clientIdRow.text.trim();
        const clientSecret = this._clientSecretRow.text.trim();
        if (!clientId || !clientSecret) {
            this._window.add_toast(new Adw.Toast({
                title: '⚠ Ingresa Client ID y Client Secret primero', timeout: 4,
            }));
            return;
        }
        this._save();
        try {
            Gio.Subprocess.new(
                ['curl', '-s', '-X', 'POST', `${DAEMON_URL}/auth/start`],
                Gio.SubprocessFlags.NONE
            );
            this._window.add_toast(new Adw.Toast({
                title: '🌐 Abriendo el navegador para autorizar…', timeout: 4,
            }));
        } catch (_e) {
            this._window.add_toast(new Adw.Toast({
                title: '❌ No se pudo contactar al daemon. ¿Está corriendo?', timeout: 4,
            }));
        }
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._refreshAuthStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _disconnect() {
        try {
            Gio.Subprocess.new(
                ['curl', '-s', '-X', 'POST', `${DAEMON_URL}/auth/reset`],
                Gio.SubprocessFlags.NONE
            );
        } catch (_e) {}
        this._window.add_toast(new Adw.Toast({ title: '✓ Cuenta desconectada', timeout: 3 }));
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refreshAuthStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Guardar
    // ─────────────────────────────────────────────────────────────────────

    _save() {
        const cfg = {
            client_id:        this._clientIdRow.text.trim(),
            client_secret:    this._clientSecretRow.text.trim(),
            calendars:        this._calendarsRow.text.trim() || 'primary',
            reminder_minutes: String(this._reminderRow.value),
            poll_interval:    String(this._pollRow.value),
            lookahead_days:   String(this._lookaheadRow.value),
        };

        const ok = this._writeConfig(cfg);

        if (ok) {
            this._restartDaemon();
            this._window.add_toast(new Adw.Toast({
                title: '✓ Guardado. El daemon se está reiniciando…', timeout: 3,
            }));
        } else {
            this._window.add_toast(new Adw.Toast({
                title: '❌ Error al guardar la configuración', timeout: 4,
            }));
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Leer / escribir config
    // ─────────────────────────────────────────────────────────────────────

    _readConfig() {
        const result = {};
        try {
            const file = Gio.File.new_for_path(CONFIG_PATH);
            const [ok, bytes] = file.load_contents(null);
            if (ok) {
                const text = new TextDecoder().decode(bytes);
                for (const raw of text.split('\n')) {
                    const line = raw.trim();
                    if (!line || line.startsWith('#')) continue;
                    const idx = line.indexOf('=');
                    if (idx < 0) continue;
                    result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
            }
        } catch (_e) {
            // El archivo aún no existe; se usarán los valores por defecto
        }
        return result;
    }

    _writeConfig(cfg) {
        try {
            const dir = Gio.File.new_for_path(CONFIG_DIR);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            const now   = new Date().toLocaleString('es-CL');
            const lines = [
                '# PowerZoid Calendar — Configuración',
                `# Guardado: ${now}`,
                '',
            ];

            if (cfg.client_id)        lines.push(`client_id=${cfg.client_id}`);
            if (cfg.client_secret)    lines.push(`client_secret=${cfg.client_secret}`);
            if (cfg.calendars)        lines.push(`calendars=${cfg.calendars}`);
            if (cfg.reminder_minutes) lines.push(`reminder_minutes=${cfg.reminder_minutes}`);
            if (cfg.poll_interval)    lines.push(`poll_interval=${cfg.poll_interval}`);
            if (cfg.lookahead_days)   lines.push(`lookahead_days=${cfg.lookahead_days}`);
            lines.push('');

            const file = Gio.File.new_for_path(CONFIG_PATH);
            file.replace_contents(
                new TextEncoder().encode(lines.join('\n')),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );

            const info = new Gio.FileInfo();
            info.set_attribute_uint32('unix::mode', 0o600);
            file.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);

            return true;
        } catch (e) {
            logError(e);
            return false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Reiniciar daemon via systemd
    // ─────────────────────────────────────────────────────────────────────

    _restartDaemon() {
        try {
            Gio.Subprocess.new(
                ['systemctl', '--user', 'restart', 'powerzoid-calendar.service'],
                Gio.SubprocessFlags.NONE
            );
        } catch (_e) {}
    }
}
