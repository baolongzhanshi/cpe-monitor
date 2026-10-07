use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SERVER_PORT: u16 = 3210;
// 启动地址随安装版本变化，避免升级首次导航仍命中旧页面的离线缓存。
const MAIN_URL: &str = concat!("http://127.0.0.1:3210/dashboard?desktopVersion=", env!("CARGO_PKG_VERSION"));
type AppResult<T> = Result<T, Box<dyn std::error::Error>>;

fn boxed_error(error: impl std::fmt::Display) -> Box<dyn std::error::Error> {
    std::io::Error::other(error.to_string()).into()
}

struct AppState {
    sidecar: Mutex<Option<Child>>,
    exiting: AtomicBool,
    opening_window: AtomicBool,
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

fn runtime_path(path: &Path) -> PathBuf {
    // Windows 规范化路径可能带扩展前缀，转换为 Node CLI 能稳定解析的路径。
    let text = path.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{}", unc))
    } else if let Some(normal) = text.strip_prefix(r"\\?\") {
        PathBuf::from(normal)
    } else {
        path.to_path_buf()
    }
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

fn spawn_server(app: &tauri::App, secrets: &RuntimeSecrets, app_data_dir: &Path) -> AppResult<Child> {
    let resource_dir = runtime_path(&app.path().resource_dir().map_err(boxed_error)?);
    let server_path = resource_dir.join("resources").join("server").join("server.js");
    if !server_path.exists() {
        return Err(boxed_error(format!("找不到内置服务: {}", server_path.display())));
    }

    let database_path = app_data_dir.join("data").join("cpe-monitor.db");
    let node_path = resource_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(node_path);
    command
        .arg(&server_path)
        .current_dir(server_path.parent().ok_or_else(|| boxed_error("服务目录无效"))?)
        .env("NODE_ENV", "production")
        .env("HOSTNAME", "127.0.0.1")
        .env("PORT", SERVER_PORT.to_string())
        .env("CPE_DESKTOP_MODE", "true")
        .env("CPE_DATABASE_PATH", database_path.to_string_lossy().to_string())
        .env("JWT_SECRET", &secrets.jwt_secret)
        .env("CPE_CONFIG_SECRET", &secrets.cpe_config_secret)
        .env("CPE_SESSION_SECRET", &secrets.cpe_session_secret)
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    // 只记录错误，单次进程最多保留 64 KiB，避免长期运行日志占满磁盘。
    command.stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(boxed_error)?;
    if let Some(mut stderr) = child.stderr.take() {
        let log_path = app_data_dir.join("startup-error.log");
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let mut log = fs::File::create(log_path).ok();
            let mut total = 0;
            let mut buffer = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut buffer) {
                if count == 0 { break; }
                let retained = count.min(65536usize.saturating_sub(total));
                if retained > 0 {
                    if let Some(file) = log.as_mut() { let _ = file.write_all(&buffer[..retained]); }
                    total += retained;
                }
            }
        });
    }
    Ok(child)
}


fn record_desktop_event(app: &AppHandle, message: &str) {
    use std::io::Write;
    if let Ok(directory) = app.path().app_data_dir() {
        let path = directory.join("desktop-events.log");
        if fs::metadata(&path).map(|meta| meta.len() >= 65536).unwrap_or(false) { return; }
        if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{message}");
        }
    }
}

fn local_server_ready() -> bool {
    use std::io::{BufRead, BufReader, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let address = SocketAddr::from(([127, 0, 0, 1], SERVER_PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) else { return false; };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    if stream.write_all(b"GET /api/system/health HTTP/1.1\r\nHost: 127.0.0.1:3210\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut status = String::new();
    BufReader::new(stream).read_line(&mut status).is_ok() && status.starts_with("HTTP/1.1 200 ")
}

fn navigate_when_ready(app: AppHandle) {
    std::thread::spawn(move || {
        for _ in 0..60 {
            if app.state::<AppState>().exiting.load(Ordering::SeqCst) { return; }
            if local_server_ready() {
                if let Some(window) = app.get_webview_window("main") {
                    match MAIN_URL.parse() {
                        Ok(url) => {
                            if let Err(error) = window.navigate(url) { record_desktop_event(&app, &format!("打开控制台失败: {error}")); }
                        }
                        Err(error) => record_desktop_event(&app, &format!("控制台地址无效: {error}")),
                    }
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        record_desktop_event(&app, "内置服务未就绪");
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval("document.getElementById('status').textContent = '本地服务启动失败，请从托盘退出后重新打开。';");
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let state = app.state::<AppState>();
    if state.opening_window.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    // Windows 创建 WebView 必须离开同步事件回调，避免阻塞主事件循环。
    std::thread::spawn(move || {
        let result = handle.config().app.windows.iter()
            .find(|config| config.label == "main")
            .cloned()
            .ok_or_else(|| boxed_error("缺少主窗口配置"))
            .and_then(|mut config| {
                config.url = WebviewUrl::External(MAIN_URL.parse().map_err(boxed_error)?);
                WebviewWindowBuilder::from_config(&handle, &config)
                    .map_err(boxed_error)?.build().map_err(boxed_error)
            });
        match result {
            Ok(window) => { let _ = window.set_focus(); }
            Err(error) => record_desktop_event(&handle, &format!("重新打开主窗口失败: {error}")),
        }
        handle.state::<AppState>().opening_window.store(false, Ordering::SeqCst);
    });
}

pub fn run() {
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            if payload.url().host_str() == Some("127.0.0.1") {
                record_desktop_event(webview.app_handle(), &format!("本地页面 {:?}: {}", payload.event(), payload.url().path()));
            }
        })
        // 重复打开应用只恢复窗口，避免额外 Node 进程和端口争用。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(AppState {
            sidecar: Mutex::new(None),
            exiting: AtomicBool::new(false),
            opening_window: AtomicBool::new(false),
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(boxed_error)?;
            let (secrets, _) = load_or_create_secrets(&app_data_dir)?;
            fs::write(app_data_dir.join("desktop-events.log"), b"").map_err(boxed_error)?;
            // 升级后清理旧的密码提示文件，数据库和设备密钥继续使用原配置。
            let _ = fs::remove_file(app_data_dir.join("first-run-password.txt"));

            let child = spawn_server(app, &secrets, &app_data_dir)?;
            app.state::<AppState>().sidecar.lock().map_err(|_| boxed_error("sidecar 状态锁定失败"))?.replace(child);

            // 由原生宿主检测服务就绪并导航，避免启动页跨域请求受到 WebView 策略限制。
            navigate_when_ready(app.handle().clone());

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
                    // 释放整个 WebView，托盘和 Node 同步服务继续运行。
                    api.prevent_close();
                    // 先关闭 WebView 控制器，避免它继续持有原生窗口资源。
                    if let Some(webview_window) = window.get_webview_window("main") {
                        let webview: &tauri::Webview = webview_window.as_ref();
                        let _ = webview.close();
                    }
                    let _ = window.destroy();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("启动 CPEye 桌面端失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !app.state::<AppState>().exiting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(mut child) = state.sidecar.lock() {
                        if let Some(mut child) = child.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
