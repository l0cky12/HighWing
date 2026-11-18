// The private folder pasted files and annotation stills wait in until they are sent or removed (src/screenshot.rs).
use hermes_chat::screenshot::{self, CaptureError, Captures};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[test]
fn errors_reach_the_webview_as_kind_and_message() {
    assert_eq!(serde_json::to_value(CaptureError::Failed("no".into())).unwrap(), serde_json::json!({ "kind": "failed", "message": "no" }));
}

#[test]
fn names_captures_plainly() {
    assert_eq!(screenshot::capture_stem("screenshot-2026-11-02-153417"), "screenshot-2026-11-02-153417");
    assert_eq!(screenshot::capture_stem("screenshot.png"), "screenshot");
    for odd in ["", "../../etc/passwd", ".hidden", "a b", "name\n", &"x".repeat(101)] {
        assert_eq!(screenshot::capture_stem(odd), "screenshot", "{odd:?}");
    }
    assert_eq!(screenshot::image_ext(b"\x89PNG\r\n\x1a\nrest"), Some("png"));
    assert_eq!(screenshot::image_ext(b"\xff\xd8\xff\xe0"), Some("jpg"));
    assert_eq!(screenshot::image_ext(b"GIF89a"), None);
}

/// A captures folder under a fresh private temp root, removed when the test ends.
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn fresh_root(tag: &str) -> (Root, Captures) {
    let base = std::env::temp_dir().join(format!("hermes-chat-test-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let captures = Captures::open(base.join("captures")).unwrap();
    (Root(base), captures)
}
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot really an image";
#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    std::fs::metadata(p).unwrap().permissions().mode() & 0o777
}

#[test]
fn writes_an_image_the_app_made_into_a_private_slot_of_its_own() {
    let (root, captures) = fresh_root("write");
    let a = captures.write("annotation-1", PNG).unwrap();
    assert_eq!(a.file_name().unwrap(), "annotation-1.png");
    assert!(a.starts_with(captures.mine()), "{a:?}");
    assert_eq!(std::fs::read(&a).unwrap(), PNG);
    #[cfg(unix)]
    {
        assert_eq!(mode(&a), 0o600);
        assert_eq!(mode(a.parent().unwrap()), 0o700);
        assert_eq!(mode(captures.mine()), 0o700);
        assert_eq!(mode(&root.0), 0o700);
    }
    assert!(captures.owns(&a));
    let b = captures.write("annotation-1", PNG).unwrap();
    assert_ne!(a.parent(), b.parent(), "each write has a fresh slot");
    assert_eq!(captures.write("../../evil", PNG).unwrap().file_name().unwrap(), "screenshot.png", "an odd name is replaced");

    assert!(matches!(captures.write("x", b"<html>"), Err(CaptureError::Failed(_))), "not an image");
    assert_eq!(std::fs::read_dir(captures.mine()).unwrap().count(), 3, "and nothing is left of it");

    assert!(captures.discard(&a));
    assert!(!a.exists() && !a.parent().unwrap().exists());
}

#[test]
fn discards_only_its_own_captures() {
    let (root, captures) = fresh_root("discard");
    let source = root.0.join("s.png");
    std::fs::write(&source, PNG).unwrap();
    let a = captures.write("shot", PNG).unwrap();
    let b = captures.write("shot", PNG).unwrap();

    // Nothing outside this process's folder can be deleted through discard.
    for other in [source.clone(), captures.mine().join("x.png"), a.parent().unwrap().join("../../../s.png"), PathBuf::from("relative/x/y.png")] {
        assert!(!captures.discard(&other), "{other:?}");
    }
    assert!(source.exists());

    assert!(captures.discard(&a));
    assert!(!a.exists() && !a.parent().unwrap().exists());
    assert!(b.exists());
    assert!(captures.discard(&a), "discarding twice is fine");

    captures.clear();
    assert!(!b.exists() && !captures.mine().exists());
}

#[test]
fn sweeps_captures_left_by_a_process_that_is_gone() {
    let (root, captures) = fresh_root("sweep");
    let kept = captures.write("mine", PNG).unwrap();
    let folder = |name: &str| {
        let f = root.0.join("captures").join(name);
        std::fs::create_dir_all(f.join("0")).unwrap();
        std::fs::write(f.join("0").join("old.png"), PNG).unwrap();
        f
    };
    let (gone, running, other) = (folder("4194999"), folder("4242"), folder("notes"));

    captures.sweep_except(|pid| pid == 4242);
    assert!(!gone.exists());
    // Another Hermes Chat still running keeps its captures; anything not named like a pid is left alone, and so are
    // this process's own.
    assert!(running.exists() && other.exists() && kept.exists());
}

#[cfg(unix)]
#[test]
fn counts_only_a_running_hermes_chat_as_alive() {
    // This test binary is running, under its own name.
    assert!(screenshot::instance_alive(std::process::id()));
    // pid 1 runs, but isn't this program: a reused pid doesn't keep a crashed run's captures.
    assert!(!screenshot::instance_alive(1));
    // pid_max is at most 2^22 on Linux, so no process has this one.
    assert!(!screenshot::instance_alive(4_194_999));
    // A child that has exited but isn't reaped yet is a zombie: gone.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--list").stdout(std::process::Stdio::null()).spawn().unwrap();
    let pid = child.id();
    for _ in 0..200 {
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        if state.rsplit_once(") ").unwrap().1.starts_with('Z') {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!screenshot::instance_alive(pid));
    child.wait().unwrap();
}

#[cfg(unix)]
#[test]
fn refuses_a_captures_folder_someone_else_could_open() {
    let base = std::env::temp_dir().join(format!("hermes-chat-test-open-{}", std::process::id()));
    let _root = Root(base.clone());
    std::fs::create_dir_all(base.join("captures")).unwrap();
    std::fs::set_permissions(base.join("captures"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(matches!(Captures::open(base.join("captures")), Err(CaptureError::Failed(m)) if m.contains("private")));

    // A link in place of the folder is refused too, even to a private folder.
    let real = base.join("real");
    std::fs::create_dir(&real).unwrap();
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::os::unix::fs::symlink(&real, base.join("linked")).unwrap();
    assert!(Captures::open(base.join("linked")).is_err());
}

#[cfg(windows)]
#[test]
fn counts_only_a_running_hermes_chat_as_alive_on_windows() {
    assert!(screenshot::instance_alive(std::process::id()));
    // The System process runs, but isn't this program.
    assert!(!screenshot::instance_alive(4));
    let mut child = std::process::Command::new(std::env::current_exe().unwrap()).arg("--list").stdout(std::process::Stdio::null()).spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(!screenshot::instance_alive(pid));
}

#[test]
fn outbox_captures_survive_exit_and_startup_until_the_message_leaves_the_outbox() {
    let (root, captures) = fresh_root("outbox");
    let mine = captures.write("pending", PNG).unwrap();
    let dead_slot = root.0.join("captures/4194999/0");
    std::fs::create_dir_all(&dead_slot).unwrap();
    let old = dead_slot.join("unknown.png");
    std::fs::write(&old, PNG).unwrap();
    let unrelated = root.0.join("unrelated.png");
    std::fs::write(&unrelated, PNG).unwrap();

    captures.retain_outbox([mine.clone(), old.clone(), unrelated.clone()]);
    captures.clear();
    assert!(mine.exists() && old.exists());
    assert!(!captures.discard(&mine));
    drop(captures);

    let restarted = Captures::open(root.0.join("captures")).unwrap();
    restarted.retain_outbox([mine.clone(), old.clone()]);
    assert!(mine.exists() && old.exists());
    // Confirmation, history reconciliation or dismissal removes the outbox reference.
    restarted.retain_outbox([]);
    assert!(!mine.exists() && !old.exists());
    assert!(unrelated.exists());
}

#[test]
fn a_reused_process_slot_never_overwrites_an_outbox_capture() {
    let (root, captures) = fresh_root("slot-reuse");
    let old = captures.mine().join("0");
    std::fs::create_dir_all(&old).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(captures.mine(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let old_file = old.join("old.png");
    std::fs::write(&old_file, PNG).unwrap();
    let new = captures.slot("new.png").unwrap();
    assert_ne!(new.parent(), Some(old.as_path()));
    assert!(old_file.exists());
    assert!(new.starts_with(root.0.join("captures")));
}

#[test]
fn shutdown_before_retention_ipc_preserves_bytes_for_startup_reconciliation() {
    let (root, captures) = fresh_root("shutdown-race");
    let pending = captures.write("pending", PNG).unwrap();
    // The renderer persisted this path but the retention IPC never ran. Native shutdown drops the store without
    // clearing it. Use a dead pid to model the next launch's view of the previous process.
    let dead = root.0.join("captures/4194999");
    std::fs::rename(captures.mine(), &dead).unwrap();
    let pending = dead.join(pending.strip_prefix(captures.mine()).unwrap());
    drop(captures);
    assert!(pending.exists());
    let restarted = Captures::open(root.0.join("captures")).unwrap();
    restarted.retain_outbox([pending.clone()]);
    assert!(pending.exists());
    restarted.retain_outbox([]);
    assert!(!pending.exists());
}

#[cfg(unix)]
#[test]
fn cleanup_never_follows_linked_instances_or_retargeted_outbox_ancestors() {
    use std::os::unix::fs::symlink;
    let (root, captures) = fresh_root("cleanup-links");
    let outside = root.0.join("outside");
    std::fs::create_dir_all(outside.join("0")).unwrap();
    let kept = outside.join("0/kept.png");
    std::fs::write(&kept, PNG).unwrap();
    let dead = root.0.join("captures/4194999");
    symlink(&outside, &dead).unwrap();
    captures.sweep_except(|_| false);
    captures.retain_outbox([dead.join("0/kept.png")]);
    captures.retain_outbox([]);
    assert!(kept.exists());
    std::fs::remove_file(&dead).unwrap();

    // A previously valid retained instance is replaced by a symlink before its reference disappears.
    std::fs::create_dir_all(dead.join("0")).unwrap();
    let old = dead.join("0/kept.png");
    std::fs::write(&old, PNG).unwrap();
    captures.retain_outbox([old]);
    std::fs::remove_dir_all(&dead).unwrap();
    symlink(&outside, &dead).unwrap();
    captures.retain_outbox([]);
    assert!(kept.exists());

    // Discard also refuses a linked slot, even in this process's own instance.
    let slot = captures.slot("kept.png").unwrap();
    std::fs::remove_dir(slot.parent().unwrap()).unwrap();
    symlink(outside.join("0"), slot.parent().unwrap()).unwrap();
    captures.discard(&slot);
    assert!(kept.exists());
}
