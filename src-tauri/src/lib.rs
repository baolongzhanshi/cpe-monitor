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
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_opener::OpenerExt;
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
    opening_browser: AtomicBool,
}

impl Drop for AppState {
    fn drop(&mut self) {
        // 退出或启动中途失败时，只清理本实例启动的 Node，不触碰其他应用。
        let child = self.sidecar.get_mut().unwrap_or_else(|error| error.into_inner());
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
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

fn open_dashboard(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.exiting.load(Ordering::SeqCst)
        || state.opening_browser.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    // 只在打开控制台时检测服务就绪；没有页面时不创建 WebView 或轮询线程。
    std::thread::spawn(move || {
        for _ in 0..60 {
            if app.state::<AppState>().exiting.load(Ordering::SeqCst) {
                app.state::<AppState>().opening_browser.store(false, Ordering::SeqCst);
                return;
            }
            if local_server_ready() {
                if let Some(tray) = app.tray_by_id("main") {
                    let _ = tray.set_tooltip(Some("CPE Monitor 监控服务运行中"));
                }
                // 地址固定为本机控制台，不接受命令行传入的 URL 或外部程序。
                match app.opener().open_url(MAIN_URL, None::<&str>) {
                    Ok(()) => record_desktop_event(&app, "已请求默认浏览器打开控制台"),
                    Err(error) => record_desktop_event(&app, &format!("打开默认浏览器失败: {error}")),
                }
                app.state::<AppState>().opening_browser.store(false, Ordering::SeqCst);
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        record_desktop_event(&app, "内置服务未就绪");
        if let Some(tray) = app.tray_by_id("main") {
            let _ = tray.set_tooltip(Some("CPE Monitor 本地服务未就绪，请退出后重新打开"));
        }
        app.state::<AppState>().opening_browser.store(false, Ordering::SeqCst);
    });
}

pub fn run() {
    tauri::Builder::default()
        // 重复启动只请求打开浏览器，现有后台服务和短信调度保持同一进程。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_dashboard(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            sidecar: Mutex::new(None),
            exiting: AtomicBool::new(false),
            opening_browser: AtomicBool::new(false),
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(boxed_error)?;
            let (secrets, _) = load_or_create_secrets(&app_data_dir)?;
            fs::write(app_data_dir.join("desktop-events.log"), b"").map_err(boxed_error)?;
            // 升级后清理旧的密码提示文件，数据库和设备密钥继续使用原配置。
            let _ = fs::remove_file(app_data_dir.join("first-run-password.txt"));

            let child = spawn_server(app, &secrets, &app_data_dir)?;
            app.state::<AppState>().sidecar.lock().map_err(|_| boxed_error("sidecar 状态锁定失败"))?.replace(child);

            let show = MenuItem::with_id(app, "show", "用浏览器打开 CPE Monitor", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出并停止同步", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let handle = app.handle().clone();
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("缺少应用图标").clone())
                .menu(&menu)
                .tooltip("CPE Monitor 正在启动本地服务")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        open_dashboard(tray.app_handle());
                    }
                })
                .on_menu_event(move |_tray, event| match event.id.as_ref() {
                    "show" => open_dashboard(&handle),
                    "quit" => {
                        handle.state::<AppState>().exiting.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            open_dashboard(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动 CPE Monitor 桌面端失败")
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
