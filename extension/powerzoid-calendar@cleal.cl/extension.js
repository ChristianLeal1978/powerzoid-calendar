/**
 * PowerZoid Calendar — GNOME Shell Extension
 * UUID: powerzoid-calendar@cleal.cl
 *
 * Muestra el próximo evento (o el que está en curso) de Google Calendar.
 * Hover      → tooltip con detalles y accesos a la videollamada
 * Clic izq.  → vista previa del evento siguiente durante 10s, luego vuelve al actual
 * Clic der.  → menú (detalles, alineación, tamaño de letra, configuración)
 * Notificación → 10 minutos (configurable) antes del evento
 */

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DAEMON_URL   = 'http://127.0.0.1:6793';
const POLL_MS       = 20000;
const VALID_ALIGNS  = ['left', 'center', 'right'];

const DEFAULT_FONT_SIZE   = 13;
const MIN_FONT_SIZE       = 8;
const MAX_FONT_SIZE       = 20;
const DEFAULT_REMINDER_MIN = 10;

const CONFIG_DIR      = `${GLib.get_home_dir()}/.config/powerzoid-calendar`;
const CONFIG_PATH     = `${CONFIG_DIR}/config`;
const POSITION_PATH   = `${CONFIG_DIR}/panel-position`;
const FONT_SIZE_PATH  = `${CONFIG_DIR}/font-size`;

const TOOLTIP_SHOW_DELAY_MS = 350;
const TOOLTIP_HIDE_DELAY_MS = 250;
const MAX_TITLE_CHARS       = 42;
const MAX_DESC_CHARS        = 220;
const PEEK_DURATION_S       = 10;
const ONGOING_COLOR         = '#e53935';


// ─────────────────────────────────────────────────────────────────────────────
// Tooltip flotante e interactivo
// ─────────────────────────────────────────────────────────────────────────────

const EventTooltip = GObject.registerClass(
class EventTooltip extends St.BoxLayout {

    _init() {
        super._init({
            style_class: 'pzc-tooltip',
            vertical:    true,
            reactive:    true,
            track_hover: true,
            visible:     false,
        });
        this._onCopyFlashTimer = null;
        Main.layoutManager.addChrome(this, { trackFullscreen: false });
    }

    setContent(ev) {
        this.destroy_all_children();

        const start = new Date(ev.start);
        const end   = new Date(ev.end);

        const title = new St.Label({ text: ev.summary, style_class: 'pzc-tooltip-title' });
        title.clutter_text.set_line_wrap(true);
        this.add_child(title);

        const dateStr  = start.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        const rangeStr = ev.all_day
            ? 'Todo el día'
            : `${_fmtTime(start)} – ${_fmtTime(end)}`;
        this.add_child(new St.Label({ text: `🕐  ${dateStr} · ${rangeStr}`, style_class: 'pzc-tooltip-line' }));

        if (ev.location)
            this.add_child(new St.Label({ text: `📍  ${ev.location}`, style_class: 'pzc-tooltip-line' }));

        const meta = [];
        if (ev.calendar_summary) meta.push(ev.calendar_summary);
        if (ev.organizer)        meta.push(`org.: ${ev.organizer}`);
        if (meta.length)
            this.add_child(new St.Label({ text: `🗓  ${meta.join(' · ')}`, style_class: 'pzc-tooltip-line pzc-dim' }));

        if (ev.description) {
            const desc = new St.Label({
                text: _truncate(ev.description, MAX_DESC_CHARS),
                style_class: 'pzc-tooltip-desc',
            });
            desc.clutter_text.set_line_wrap(true);
            this.add_child(desc);
        }

        if (ev.meeting_url) {
            this.add_child(new St.Widget({ style_class: 'pzc-tooltip-sep' }));

            const row = new St.BoxLayout({ style_class: 'pzc-tooltip-actions' });

            const joinBtn = new St.Button({
                style_class: 'pzc-tooltip-button pzc-tooltip-button-primary',
                label: `🔗  Unirse${ev.meeting_provider ? ' · ' + ev.meeting_provider : ''}`,
            });
            joinBtn.connect('clicked', () => {
                Gio.AppInfo.launch_default_for_uri(ev.meeting_url, null);
            });
            row.add_child(joinBtn);

            const copyBtn = new St.Button({
                style_class: 'pzc-tooltip-button',
                label: '📋  Copiar',
            });
            copyBtn.connect('clicked', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ev.meeting_url);
                copyBtn.label = '✓  Copiado';
                if (this._onCopyFlashTimer) GLib.source_remove(this._onCopyFlashTimer);
                this._onCopyFlashTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                    copyBtn.label = '📋  Copiar';
                    this._onCopyFlashTimer = null;
                    return GLib.SOURCE_REMOVE;
                });
            });
            row.add_child(copyBtn);

            this.add_child(row);
        }
    }

    showNear(sourceActor) {
        const [srcX, srcY] = sourceActor.get_transformed_position();
        const [, srcH]     = sourceActor.get_transformed_size();

        this.opacity = 0;
        this.visible = true;
        // Necesitamos el tamaño ya calculado; get_preferred_size fuerza layout.
        const [, , naturalW, naturalH] = this.get_preferred_size();

        const monitor = Main.layoutManager.findMonitorForActor(sourceActor) || Main.layoutManager.primaryMonitor;
        let x = srcX;
        let y = srcY + srcH + 6;

        if (x + naturalW > monitor.x + monitor.width - 8)
            x = monitor.x + monitor.width - naturalW - 8;
        if (x < monitor.x + 8)
            x = monitor.x + 8;

        this.set_position(Math.round(x), Math.round(y));
        this.opacity = 255;
    }

    hide() {
        this.visible = false;
    }

    destroy() {
        if (this._onCopyFlashTimer) { GLib.source_remove(this._onCopyFlashTimer); this._onCopyFlashTimer = null; }
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Helpers de formato
// ─────────────────────────────────────────────────────────────────────────────

function _fmtTime(date) {
    return date.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function _truncate(text, max) {
    if (!text) return '';
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

function _isSameDay(a, b) {
    return a.toDateString() === b.toDateString();
}

function _isTomorrow(date, now) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return _isSameDay(date, tomorrow);
}

function _formatWhen(ev) {
    const start = new Date(ev.start);
    const now   = new Date();

    if (ev.all_day) {
        if (_isSameDay(start, now)) return 'Hoy';
        if (_isTomorrow(start, now)) return 'Mañana';
        return start.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' });
    }
    if (ev.is_ongoing) return 'AHORA';

    const diffMin = Math.round((start - now) / 60000);
    if (diffMin <= 0) return 'AHORA';
    if (diffMin < 60) return `en ${diffMin} min`;

    const timeStr = _fmtTime(start);
    if (_isSameDay(start, now)) return timeStr;
    if (_isTomorrow(start, now)) return `Mañana ${timeStr}`;
    return `${start.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' })} ${timeStr}`;
}


// ─────────────────────────────────────────────────────────────────────────────
// Indicador en el panel
// ─────────────────────────────────────────────────────────────────────────────

const CalendarIndicator = GObject.registerClass(
class CalendarIndicator extends PanelMenu.Button {

    _init(extension, initialAlign = 'left', initialFontSize = DEFAULT_FONT_SIZE) {
        super._init(0.0, 'PowerZoid Calendar');

        this._ext           = extension;
        this._currentAlign  = initialAlign;
        this._fontSize      = initialFontSize;
        this._fontSizeItem  = null;
        this._session       = new Soup.Session();
        this._session.timeout = 5;
        this._lastState      = 'starting';
        this._lastEvent       = null;
        this._lastStatus       = null;
        this._lastUpcoming     = [];
        this._notifiedEventId = null;
        this._notifSource      = null;
        this._tooltip           = new EventTooltip();
        this._showTimer         = null;
        this._hideTimer         = null;
        this._peekTimer         = null;
        this._isPeeking         = false;
        this._currentDotColor   = '#9e9e9e';
        this._dismissedEventId  = null;
        this._lastRawStatus     = null;

        // ── Panel: [hora/AHORA] [●] [título], todo dentro del borde ───────
        this._timeLabel = new St.Label({
            text:    '',
            y_align: Clutter.ActorAlign.CENTER,
            style:   this._labelStyle(),
        });
        this._dot = new St.Label({
            text:    '●',
            y_align: Clutter.ActorAlign.CENTER,
            style:   this._dotStyle('#9e9e9e'),
        });
        this._titleLabel = new St.Label({
            text:    '📅  Cargando…',
            y_align: Clutter.ActorAlign.CENTER,
            style:   this._labelStyle(),
        });
        const inner = new St.BoxLayout({ style_class: 'pzc-panel-label' });
        inner.add_child(this._timeLabel);
        inner.add_child(this._dot);
        inner.add_child(this._titleLabel);
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });
        box.add_child(inner);
        this.add_child(box);

        // PanelMenu.Button abre su menú con CUALQUIER botón apenas se
        // presiona, y aparentemente detiene ahí mismo la señal local
        // 'button-press-event' (nuestro propio manejador, conectado
        // después, nunca llegaba a ejecutarse). Registramos el botón
        // escuchando en la fase de "captura" del stage —anterior a
        // cualquier lógica interna del actor— solo para recordarlo.
        this._lastPressButton = null;
        this._captureId = global.stage.connect('captured-event', (_stage, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS)
                this._lastPressButton = ev.get_button();
            return Clutter.EVENT_PROPAGATE;
        });

        // ── Hover: tooltip flotante ───────────────────────────────────────
        this.connect('enter-event', () => this._onHoverEnter());
        this.connect('leave-event', () => this._onHoverLeave());
        this._tooltip.connect('enter-event', () => this._onHoverEnter());
        this._tooltip.connect('leave-event', () => this._onHoverLeave());
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) return;
            this._hideTooltipNow();
            if (this._lastPressButton !== 1) return;
            this._lastPressButton = null;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.menu.close();
                this._peekNextEvent();
                return GLib.SOURCE_REMOVE;
            });
        });

        // ── Menú ───────────────────────────────────────────────────────
        this._buildMenu();

        this._pollTimer = null;
        this._startPolling();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Construcción del menú
    // ─────────────────────────────────────────────────────────────────────

    _buildMenu() {
        this._eventSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._eventSection);
        this._rebuildEventSection({ state: 'starting' });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('🔄  Actualizar ahora');
        refreshItem.connect('activate', () => this._triggerRefresh());
        this.menu.addMenuItem(refreshItem);

        this._openCalItem = new PopupMenu.PopupMenuItem('🌐  Abrir en Google Calendar');
        this._openCalItem.connect('activate', () => {
            if (this._lastEvent?.html_link)
                Gio.AppInfo.launch_default_for_uri(this._lastEvent.html_link, null);
        });
        this._openCalItem.setSensitive(false);
        this.menu.addMenuItem(this._openCalItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Submenú de alineación ─────────────────────────────────────────
        this._posSubMenu = new PopupMenu.PopupSubMenuMenuItem('Posición en barra');
        this.menu.addMenuItem(this._posSubMenu);

        this._alignItems = {};
        [
            ['← Alinear a la izquierda', 'left'],
            ['↔ Alinear al centro',       'center'],
            ['→ Alinear a la derecha',    'right'],
        ].forEach(([label, align]) => {
            const item = new PopupMenu.PopupMenuItem(label);
            this._alignItems[align] = item;
            item.connect('activate', () => this._setAlignment(align));
            this._posSubMenu.menu.addMenuItem(item);
        });
        this._updateAlignMarks(this._currentAlign);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // ── Tamaño de letra ────────────────────────────────────────────
        this._fontSizeItem = new PopupMenu.PopupMenuItem(this._fontSizeLabel(), { reactive: false });
        this._fontSizeItem.label.set_style('color: #aaa; font-style: italic;');
        this.menu.addMenuItem(this._fontSizeItem);

        const increaseItem = new PopupMenu.PopupMenuItem('A+   Aumentar letra');
        increaseItem.connect('activate', () => this._changeFontSize(1));
        this.menu.addMenuItem(increaseItem);

        const decreaseItem = new PopupMenu.PopupMenuItem('A−   Reducir letra');
        decreaseItem.connect('activate', () => this._changeFontSize(-1));
        this.menu.addMenuItem(decreaseItem);

        const resetItem = new PopupMenu.PopupMenuItem('↺    Restablecer tamaño');
        resetItem.connect('activate', () => {
            this._fontSize = DEFAULT_FONT_SIZE;
            this._applyFontSize();
            this._ext.saveFontSize(this._fontSize);
        });
        this.menu.addMenuItem(resetItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('⚙  Configuración…');
        prefsItem.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    _rebuildEventSection(status) {
        this._eventSection.removeAll();

        const addLine = (text, style = null) => {
            const item = new PopupMenu.PopupMenuItem(text, { reactive: false });
            if (style) item.label.set_style(style);
            item.label.clutter_text.set_line_wrap(true);
            this._eventSection.addMenuItem(item);
            return item;
        };

        if (status.state === 'starting') {
            addLine('Cargando…', 'font-style: italic; color: #aaa;');
            return;
        }
        if (status.state === 'disconnected') {
            addLine('⚠  El daemon no está disponible', 'color: #f44336;');
            addLine('Verifica: systemctl --user status powerzoid-calendar', 'font-size: 0.85em; color: #888;');
            return;
        }
        if (status.state === 'no_config') {
            addLine('⚙  Configura tu cuenta de Google en "Configuración…"', 'font-style: italic;');
            return;
        }
        if (status.state === 'no_auth') {
            const item = new PopupMenu.PopupMenuItem('🔐  Conectar con Google Calendar');
            item.connect('activate', () => this._startAuth());
            this._eventSection.addMenuItem(item);
            if (status.error)
                addLine(`⚠  ${status.error}`, 'font-size: 0.85em; color: #ff9800;');
            return;
        }
        if (status.state === 'error') {
            addLine(`⚠  Error: ${status.error || 'desconocido'}`, 'color: #f44336;');
            return;
        }
        if (status.state === 'empty' || !status.event) {
            addLine('📅  No hay eventos próximos');
            return;
        }

        const ev = status.event;
        addLine(ev.summary, 'font-weight: bold;');

        const start    = new Date(ev.start);
        const end      = new Date(ev.end);
        const dateStr  = start.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
        const rangeStr = ev.all_day ? 'Todo el día' : `${_fmtTime(start)} – ${_fmtTime(end)}`;
        addLine(`🕐  ${dateStr} · ${rangeStr}`);

        if (ev.location) addLine(`📍  ${ev.location}`);
        if (ev.calendar_summary) addLine(`🗓  ${ev.calendar_summary}`, 'color: #aaa;');
        if (ev.description) addLine(_truncate(ev.description, 160), 'color: #aaa;');

        if (ev.meeting_url) {
            const joinItem = new PopupMenu.PopupMenuItem(
                `🔗  Unirse${ev.meeting_provider ? ' · ' + ev.meeting_provider : ''}`
            );
            joinItem.connect('activate', () => Gio.AppInfo.launch_default_for_uri(ev.meeting_url, null));
            this._eventSection.addMenuItem(joinItem);

            const copyItem = new PopupMenu.PopupMenuItem('📋  Copiar enlace de la reunión');
            copyItem.connect('activate', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ev.meeting_url);
            });
            this._eventSection.addMenuItem(copyItem);
        }

        const dismissItem = new PopupMenu.PopupMenuItem('✓  Marcar como transcurrido');
        dismissItem.connect('activate', () => this._dismissCurrentEvent(ev.id));
        this._eventSection.addMenuItem(dismissItem);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Vista previa del próximo evento (clic izquierdo)
    // ─────────────────────────────────────────────────────────────────────

    _peekNextEvent() {
        if (this._lastState !== 'ok' && this._lastState !== 'empty') return;

        if (this._peekTimer) { GLib.source_remove(this._peekTimer); this._peekTimer = null; }

        const nextEv = this._lastUpcoming[0];
        this._isPeeking = true;
        this._applyPanelParts(nextEv
            ? { ...this._composeEventParts(nextEv), time: `⏭ ${_formatWhen(nextEv)}` }
            : { time: '', title: '⏭  Sin más eventos próximos', dot: null });

        this._peekTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PEEK_DURATION_S, () => {
            this._peekTimer = null;
            this._isPeeking = false;
            this._applyPanelParts(this._composeStatusParts(this._lastStatus));
            return GLib.SOURCE_REMOVE;
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Marcar evento actual como transcurrido (clic derecho → menú)
    // ─────────────────────────────────────────────────────────────────────

    _dismissCurrentEvent(eventId) {
        this._dismissedEventId = eventId;
        if (this._lastRawStatus)
            this._applyStatus(this._lastRawStatus);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tooltip
    // ─────────────────────────────────────────────────────────────────────

    _onHoverEnter() {
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
        if (this._tooltip.visible) return;
        if (this.menu.isOpen) return;
        if (!this._lastEvent) return;
        if (this._showTimer) return;

        this._showTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
            this._showTimer = null;
            if (this._lastEvent) {
                this._tooltip.setContent(this._lastEvent);
                this._tooltip.showNear(this);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _onHoverLeave() {
        if (this._showTimer) { GLib.source_remove(this._showTimer); this._showTimer = null; }
        if (this._hideTimer) return;
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_HIDE_DELAY_MS, () => {
            this._hideTimer = null;
            this._tooltip.hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _hideTooltipNow() {
        if (this._showTimer) { GLib.source_remove(this._showTimer); this._showTimer = null; }
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
        this._tooltip.hide();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Tamaño de letra
    // ─────────────────────────────────────────────────────────────────────

    _fontSizeLabel() {
        return `Tamaño: ${this._fontSize} px`;
    }

    _changeFontSize(delta) {
        this._fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, this._fontSize + delta));
        this._applyFontSize();
        this._ext.saveFontSize(this._fontSize);
    }

    _applyFontSize() {
        this._timeLabel?.set_style(this._labelStyle());
        this._titleLabel?.set_style(this._labelStyle());
        this._dot?.set_style(this._dotStyle(this._currentDotColor));
        this._fontSizeItem?.label.set_text(this._fontSizeLabel());
    }

    _labelStyle() {
        return `font-size: ${this._fontSize}px;`;
    }

    _dotStyle(color) {
        return `font-size: ${this._fontSize}px; color: ${color};`;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Alineación
    // ─────────────────────────────────────────────────────────────────────

    _setAlignment(align) {
        if (align === this._currentAlign) return;
        this._ext.savePanelPosition(align);

        // Reinicio completo de la extensión: evita bugs de rendering al
        // reubicar actores directamente entre boxes del panel en versiones
        // recientes de GNOME Shell.
        const uuid = this._ext.uuid;
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            Main.extensionManager.disableExtension(uuid);
            Main.extensionManager.enableExtension(uuid);
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateAlignMarks(activeAlign) {
        Object.entries(this._alignItems).forEach(([align, item]) => {
            item.setOrnament(
                align === activeAlign ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE
            );
        });
    }

    // ─────────────────────────────────────────────────────────────────────
    // Polling al daemon
    // ─────────────────────────────────────────────────────────────────────

    _startPolling() {
        this._fetchStatus();
        this._pollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
            this._fetchStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fetchStatus() {
        let msg;
        try { msg = Soup.Message.new('GET', `${DAEMON_URL}/status`); }
        catch (_e) { this._applyDisconnected(); return; }

        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const data  = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    this._applyStatus(data);
                } catch (_e) {
                    this._applyDisconnected();
                }
            }
        );
    }

    _triggerRefresh() {
        let msg;
        try { msg = Soup.Message.new('POST', `${DAEMON_URL}/refresh`); }
        catch (_e) { return; }
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => { try { session.send_and_read_finish(result); } catch (_e) {} }
        );
    }

    _startAuth() {
        let msg;
        try { msg = Soup.Message.new('POST', `${DAEMON_URL}/auth/start`); }
        catch (_e) { return; }
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null,
            (session, result) => {
                try { session.send_and_read_finish(result); } catch (_e) {}
                this._fetchStatus();
            }
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Actualización de UI
    // ─────────────────────────────────────────────────────────────────────

    // Si el evento actual fue marcado "transcurrido" a mano, lo saltamos y
    // promovemos el siguiente de la lista `upcoming` mientras el daemon
    // siga reportando el mismo id (hasta que su hora real termine).
    _applyDismissFilter(status) {
        if (this._dismissedEventId && status.event?.id !== this._dismissedEventId)
            this._dismissedEventId = null;

        if (status.state !== 'ok' || status.event?.id !== this._dismissedEventId)
            return status;

        const upcoming = status.upcoming || [];
        if (!upcoming.length)
            return { ...status, state: 'empty', event: null, upcoming: [] };

        const [event, ...rest] = upcoming;
        return { ...status, event, upcoming: rest };
    }

    _applyStatus(rawStatus) {
        this._lastRawStatus = rawStatus;
        const status = this._applyDismissFilter(rawStatus);

        this._lastState    = status.state || 'error';
        this._lastEvent    = (status.state === 'ok') ? status.event : null;
        this._lastStatus   = status;
        this._lastUpcoming = status.upcoming || [];

        if (!this._isPeeking)
            this._applyPanelParts(this._composeStatusParts(status));

        this._openCalItem.setSensitive(!!this._lastEvent?.html_link);
        this._rebuildEventSection(status);

        if (this._tooltip.visible && this._lastEvent)
            this._tooltip.setContent(this._lastEvent);
        else if (this._tooltip.visible && !this._lastEvent)
            this._hideTooltipNow();

        if (status.state === 'ok' && status.event)
            this._maybeNotify(status.event);
    }

    _applyDisconnected() {
        if (this._lastState === 'disconnected') return;
        if (this._peekTimer) { GLib.source_remove(this._peekTimer); this._peekTimer = null; }
        this._isPeeking     = false;
        this._lastState     = 'disconnected';
        this._lastEvent     = null;
        this._lastStatus    = { state: 'disconnected' };
        this._lastRawStatus = { state: 'disconnected' };
        this._lastUpcoming  = [];
        this._applyPanelParts({ time: '', title: '📅  Daemon no disponible', dot: null });
        this._openCalItem.setSensitive(false);
        this._rebuildEventSection({ state: 'disconnected' });
        this._hideTooltipNow();
    }

    // ── Composición del contenido del panel (hora · punto · título) ──────

    _composeEventParts(ev) {
        return {
            time:  _formatWhen(ev),
            title: _truncate(ev.summary, MAX_TITLE_CHARS),
            dot:   ev.is_ongoing ? ONGOING_COLOR : (ev.color || '#9e9e9e'),
        };
    }

    _composeStatusParts(status) {
        if (status.state === 'ok' && status.event)
            return this._composeEventParts(status.event);

        const messages = {
            starting:     '📅  Cargando…',
            no_config:    '📅  Configurar cuenta',
            no_auth:      '📅  Conectar cuenta',
            error:        '📅  Error',
            empty:        '📅  Sin eventos',
            disconnected: '📅  Daemon no disponible',
        };
        return { time: '', title: messages[status.state] || '📅  …', dot: null };
    }

    _applyPanelParts({ time, title, dot }) {
        this._currentDotColor = dot || '#9e9e9e';
        this._timeLabel.text  = time;
        this._timeLabel.visible = !!time;
        this._dot.visible = !!dot;
        this._dot.set_style(this._dotStyle(this._currentDotColor));
        this._titleLabel.text = title;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Notificación de aviso previo
    // ─────────────────────────────────────────────────────────────────────

    _maybeNotify(ev) {
        const start        = new Date(ev.start);
        const now          = new Date();
        const minsUntil    = (start - now) / 60000;
        const reminderMin  = this._ext.getReminderMinutes();

        if (ev.all_day) return;
        if (this._notifiedEventId === ev.id) return;
        if (minsUntil > reminderMin || minsUntil < -1) return;

        this._notifiedEventId = ev.id;
        this._fireNotification(ev, Math.max(0, Math.round(minsUntil)));
    }

    _fireNotification(ev, minsUntil) {
        if (!this._notifSource) {
            this._notifSource = new MessageTray.Source({
                title:    'PowerZoid Calendar',
                iconName: 'x-office-calendar-symbolic',
            });
            Main.messageTray.add(this._notifSource);
        }

        const when = minsUntil <= 0 ? 'está por comenzar' : `comienza en ${minsUntil} min`;
        const bodyParts = [when];
        if (ev.location) bodyParts.push(ev.location);

        const notification = new MessageTray.Notification({
            source:   this._notifSource,
            title:    ev.summary,
            body:     bodyParts.join(' · '),
            iconName: 'x-office-calendar-symbolic',
        });

        if (ev.meeting_url) {
            notification.addAction('Unirse', () => {
                Gio.AppInfo.launch_default_for_uri(ev.meeting_url, null);
            });
            notification.addAction('Copiar enlace', () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ev.meeting_url);
            });
        }

        this._notifSource.addNotification(notification);
    }

    // ─────────────────────────────────────────────────────────────────────
    // Limpieza
    // ─────────────────────────────────────────────────────────────────────

    destroy() {
        if (this._pollTimer) { GLib.source_remove(this._pollTimer); this._pollTimer = null; }
        if (this._showTimer) { GLib.source_remove(this._showTimer); this._showTimer = null; }
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = null; }
        if (this._peekTimer) { GLib.source_remove(this._peekTimer); this._peekTimer = null; }
        if (this._captureId) { global.stage.disconnect(this._captureId); this._captureId = null; }
        this._tooltip?.destroy();
        this._notifSource?.destroy();
        super.destroy();
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────

export default class PowerZoidCalendarExtension extends Extension {

    enable() {
        const align    = this._loadPanelPosition();
        const fontSize = this._loadFontSize();
        this._indicator = new CalendarIndicator(this, align, fontSize);
        Main.panel.addToStatusArea('powerzoid-calendar', this._indicator, -1, align);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    // ── Alineación ──────────────────────────────────────────────────────

    _loadPanelPosition() {
        try {
            const file = Gio.File.new_for_path(POSITION_PATH);
            const [, bytes] = file.load_contents(null);
            const val = new TextDecoder().decode(bytes).trim();
            return VALID_ALIGNS.includes(val) ? val : 'left';
        } catch (_e) {}
        return 'left';
    }

    savePanelPosition(align) {
        try {
            Gio.File.new_for_path(CONFIG_DIR).make_directory_with_parents(null);
        } catch (_e) {}
        try {
            const file = Gio.File.new_for_path(POSITION_PATH);
            file.replace_contents(
                new TextEncoder().encode(align),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (_e) {}
    }

    // ── Tamaño de letra ────────────────────────────────────────────────

    _loadFontSize() {
        try {
            const file = Gio.File.new_for_path(FONT_SIZE_PATH);
            const [, bytes] = file.load_contents(null);
            const val = parseInt(new TextDecoder().decode(bytes).trim(), 10);
            if (Number.isInteger(val))
                return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, val));
        } catch (_e) {}
        return DEFAULT_FONT_SIZE;
    }

    saveFontSize(size) {
        try {
            Gio.File.new_for_path(CONFIG_DIR).make_directory_with_parents(null);
        } catch (_e) {}
        try {
            const file = Gio.File.new_for_path(FONT_SIZE_PATH);
            file.replace_contents(
                new TextEncoder().encode(String(size)),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
        } catch (_e) {}
    }

    // ── Preferencias compartidas con el daemon (config combinado) ───────

    getReminderMinutes() {
        try {
            const file = Gio.File.new_for_path(CONFIG_PATH);
            const [, bytes] = file.load_contents(null);
            const text = new TextDecoder().decode(bytes);
            for (const raw of text.split('\n')) {
                const line = raw.trim();
                if (line.startsWith('reminder_minutes=')) {
                    const val = parseInt(line.slice(18).trim(), 10);
                    if (Number.isInteger(val) && val >= 0) return val;
                }
            }
        } catch (_e) {}
        return DEFAULT_REMINDER_MIN;
    }
}
