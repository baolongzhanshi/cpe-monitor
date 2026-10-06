use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::Path,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const SERVER_PORT: u16 = 3210;
type AppResult<T> = Result<T, Box<dyn std::error::Error>>;

fn boxed_error(error: impl std::fmt::Display) -> Box<dyn std::error::Error> {
    std::io::Error::other(error.to_string()).into()
}

struct AppState {
    sidecar: Mutex<Option<CommandChild>>,
    exiting: AtomicBool,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeSecrets {
    admin_password: String,
    jwt_secret: String,
    cpe_config_secret: String,
    cpe_session_secret: String,
}

fn random_secret(length: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(length)
        .map(char::from)
        .collect()
}

fn load_or_create_secrets(app_data_dir: &Path) -> AppResult<(RuntimeSecrets, bool)> {
    fs::create_dir_all(app_data_dir).map_err(boxed_error)?;
    let secrets_path = app_data_dir.join("runtime-secrets.json");
    if secrets_path.exists() {
        let content = fs::read_to_string(&secrets_path).map_err(boxed_error)?;
        let secrets = serde_json::from_str(&content).map_err(boxed_error)?;
        return Ok((secrets, false));
    }

    let secrets = RuntimeSecrets {
        admin_password: random_secret(16),
        jwt_secret: random_secret(48),
        cpe_config_secret: random_secret(48),
        cpe_session_secret: random_secret(48),
    };
    let content = serde_json::to_string_pretty(&secrets).map_err(boxed_error)?;
    fs::write(&secrets_path, content).map_err(boxed_error)?;
    Ok((secrets, true))
}

fn spawn_server(app: &tauri::App, secrets: &RuntimeSecrets, app_data_dir: &Path) -> AppResult<CommandChild> {
    let resource_dir = app.path().resource_dir().map_err(boxed_error)?;
    let server_path = resource_dir.join("resources").join("server").join("server.js");
    if !server_path.exists() {
        return Err(boxed_error(format!("找不到内置服务: {}", server_path.display())));
    }

    let database_path = app_data_dir.join("data").join("cpe-monitor.db");
    let first_run_path = app_data_dir.join("first-run-password.txt");
    let command = app
        .shell()
        .sidecar("node")
        .map_err(boxed_error)?
        .args([server_path.to_string_lossy().to_string()])
        .env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", SERVER_PORT.to_string())
        .env("CPE_DATABASE_PATH", database_path.to_string_lossy().to_string())
        .env("CPE_FIRST_RUN_PASSWORD_FILE", first_run_path.to_string_lossy().to_string())
        .env("ADMIN_PASSWORD", &secrets.admin_password)
        .env("JWT_SECRET", &secrets.jwt_secret)
        .env("CPE_CONFIG_SECRET", &secrets.cpe_config_secret)
        .env("CPE_SESSION_SECRET", &secrets.cpe_session_secret);

    let (mut events, child) = command.spawn().map_err(boxed_error)?;
    // 持续消费子进程输出，避免 stdout/stderr 管道积压阻塞服务。
    tauri::async_runtime::spawn(async move {
        while events.recv().await.is_some() {}
    });
    Ok(child)
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // 重复打开应用只恢复窗口，避免额外 Node 进程和端口争用。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            sidecar: Mutex::new(None),
            exiting: AtomicBool::new(false),
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(boxed_error)?;
            let (secrets, first_run) = load_or_create_secrets(&app_data_dir)?;
            if first_run {
                let first_run_path = app_data_dir.join("first-run-password.txt");
                fs::write(first_run_path, &secrets.admin_password).map_err(boxed_error)?;
            }

            let child = spawn_server(app, &secrets, &app_data_dir)?;
            app.state::<AppState>().sidecar.lock().map_err(|_| boxed_error("sidecar 状态锁定失败"))?.replace(child);

            let show = MenuItem::with_id(app, "show", "打开 CPEye", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出并停止同步", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let handle = app.handle().clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .menu(&menu)
                .tooltip("CPEye 监控服务运行中")
                .on_menu_event(move |_tray, event| match event.id.as_ref() {
                    "show" => show_main_window(&handle),
                    "quit" => {
                        handle.state::<AppState>().exiting.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.exiting.load(Ordering::SeqCst) {
                    // 关闭窗口只隐藏到托盘，后台同步继续运行。
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 CPEye 桌面端失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut child) = state.sidecar.lock() {
                        if let Some(child) = child.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
