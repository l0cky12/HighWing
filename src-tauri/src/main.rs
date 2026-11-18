#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer draws a blank window on some GPU drivers (ADR 0221). Set before any thread starts,
    // because set_var isn't safe beside other threads.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    use hermes_chat::remote;
    // An update's restart starts a new app while the old one is still exiting (update.rs); it must not just ask that
    // one to show itself. Not passed on to what the app starts.
    let new_instance = std::env::var_os(remote::NEW_INSTANCE).is_some();
    std::env::remove_var(remote::NEW_INSTANCE);
    // The desktop's activation token for this launch, handed on so the running window may take focus.
    let token = ["XDG_ACTIVATION_TOKEN", "DESKTOP_STARTUP_ID"].iter().find_map(|v| std::env::var(v).ok().filter(|t| !t.is_empty()));
    // `hermes-chat --stop`, `--show` or `--toggle` from a desktop shortcut, a chat link the desktop opened
    // (`hermes-chat %u`), or a plain launch: the Hermes Chat already running does it, so there is only one.
    let request = remote::request_of(std::env::args(), token, new_instance);
    let stop = request == Some(remote::Request::Stop);
    // Kept for this app's own window if it is the one that starts (links.rs).
    let link = hermes_chat::links::from_args(std::env::args());
    if remote::hand_over(request) {
        return;
    }
    hermes_chat::run(link, stop)
}
