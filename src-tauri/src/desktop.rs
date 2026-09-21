use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};

const TRAY_ID: &str = "splitwave";
const ACTION_EVENT: &str = "desktop://action";

#[derive(Default)]
pub struct DesktopState {
    ready: AtomicBool,
    close_to_tray: AtomicBool,
    exit_requested: AtomicBool,
    exiting: AtomicBool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayPipeline {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    close_to_tray: bool,
    launch_on_startup: bool,
    start_in_tray: bool,
    running_pipeline_id: Option<String>,
    busy: bool,
    pipelines: Vec<TrayPipeline>,
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn request_exit(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if !state.exit_requested.swap(true, Ordering::SeqCst) {
        if let Err(error) = app.emit(ACTION_EVENT, "quit") {
            state.exit_requested.store(false, Ordering::SeqCst);
            tracing::error!(%error, "failed to request a clean shutdown");
            let _ = show_main_window(app.clone());
        }
    }
}

#[tauri::command]
pub fn cancel_desktop_exit(state: State<'_, DesktopState>) {
    state.exit_requested.store(false, Ordering::SeqCst);
}

#[tauri::command]
pub fn complete_desktop_exit(app: AppHandle, state: State<'_, DesktopState>) {
    state.exiting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if app.tray_by_id(TRAY_ID).is_none() {
        return Err("System tray is unavailable; keeping the window open".into());
    }
    app.get_webview_window("main")
        .ok_or("Main window is unavailable")?
        .hide()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_desktop(
    app: AppHandle,
    state: State<'_, DesktopState>,
    config: TrayState,
) -> Result<(), String> {
    build_tray(&app, &config).map_err(|e| e.to_string())?;
    state
        .close_to_tray
        .store(config.close_to_tray, Ordering::SeqCst);
    state.ready.store(true, Ordering::SeqCst);
    Ok(())
}

fn build_tray(app: &AppHandle, config: &TrayState) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "desktop:open",
        "Open Splitwave",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "desktop:autostart",
        "Launch on system startup",
        !config.busy,
        config.launch_on_startup,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "desktop:start-in-tray",
        "Start in system tray",
        !config.busy,
        config.start_in_tray,
        None::<&str>,
    )?)?;
    let pipelines = Submenu::new(app, "Pipelines (one at a time)", !config.busy)?;
    for pipeline in &config.pipelines {
        let running = config.running_pipeline_id.as_deref() == Some(&pipeline.id);
        pipelines.append(&CheckMenuItem::with_id(
            app,
            format!("desktop:pipeline:{}", pipeline.id),
            &pipeline.name,
            !config.busy && (config.running_pipeline_id.is_none() || running),
            running,
            None::<&str>,
        )?)?;
    }
    menu.append(&pipelines)?;
    menu.append(&MenuItem::with_id(
        app,
        "desktop:stop",
        "Stop audio",
        !config.busy && config.running_pipeline_id.is_some(),
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "desktop:quit",
        "Quit Splitwave",
        !config.busy,
        None::<&str>,
    )?)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    } else {
        let mut builder = TrayIconBuilder::with_id(TRAY_ID)
            .tooltip("Splitwave")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id == "desktop:open" {
                    let _ = show_main_window(app.clone());
                } else if id == "desktop:quit" {
                    request_exit(app);
                } else if let Some(action) = id.strip_prefix("desktop:") {
                    let _ = app.emit(ACTION_EVENT, action);
                }
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    let _ = show_main_window(tray.app_handle().clone());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
    }
    Ok(())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        let state = app.state::<DesktopState>();
        if !state.ready.load(Ordering::SeqCst) || state.exiting.load(Ordering::SeqCst) {
            return;
        }
        api.prevent_close();
        if state.close_to_tray.load(Ordering::SeqCst) {
            if let Err(error) = hide_main_window(app.clone()) {
                tracing::error!(%error, "failed to hide main window");
            }
        } else {
            request_exit(app);
        }
    }
}

pub fn run_event(app: &AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
        let state = app.state::<DesktopState>();
        if state.ready.load(Ordering::SeqCst)
            && !state.exiting.load(Ordering::SeqCst)
            && code.unwrap_or(0) == 0
        {
            api.prevent_exit();
            request_exit(app);
        }
    }
}
