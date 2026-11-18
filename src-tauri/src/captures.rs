//! The private folder where files wait until their message is sent: files pasted or dropped into the composer, and
//! the Preview's annotated stills (annotate.rs). Nothing leaves this computer until the message is sent.
//!
//! Files are written privately under `$XDG_CACHE_HOME/hermes-chat/captures/<pid>/` (on Windows
//! `%LOCALAPPDATA%\hermes-chat\captures\<pid>\`). Unsent files are removed on abandonment or exit; a file needed by a
//! failed/unknown message stays with its outbox until accepted, reconciled or dismissed. Crash leftovers without an
//! outbox reference are swept at startup.

use crate::lock::Locked;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Why a file couldn't be staged. Sent to the webview as `{ kind, message }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum CaptureError {
    #[error("{0}")]
    Failed(String),
}

fn failed(what: &str, e: impl std::fmt::Display) -> CaptureError {
    CaptureError::Failed(format!("{what}: {e}"))
}

/// A file staged for the composer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Capture {
    pub path: String,
}

/// The folder captures are staged in, private to this user, and the subfolder this process owns.
#[derive(Debug)]
pub struct Captures {
    root: PathBuf,
    mine: PathBuf,
    next: AtomicU64,
    retained: Mutex<HashSet<PathBuf>>,
}

/// Folders and files only this user can open. On Linux by owner and mode (0700, 0600). On Windows by the ACL a new
/// folder inherits: the captures root is in `%LOCALAPPDATA%`, which grants only this user, SYSTEM and Administrators,
/// so nothing is set or checked beyond that, and a link in place of a folder is still refused.
mod private {
    #[cfg(unix)]
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    #[cfg(unix)]
    fn my_uid() -> std::io::Result<u32> {
        Ok(std::fs::metadata("/proc/self")?.uid())
    }

    pub fn create_dir(dir: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        return std::fs::DirBuilder::new().mode(0o700).create(dir);
        #[cfg(windows)]
        return std::fs::create_dir(dir);
    }

    /// A new file, never one already there.
    pub fn create_file(path: &Path) -> std::io::Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        options.open(path)
    }

    /// `meta` is of something this user owns. On Windows, whatever this user can read is taken as theirs.
    pub fn mine(meta: &std::fs::Metadata) -> std::io::Result<bool> {
        #[cfg(unix)]
        return Ok(meta.uid() == my_uid()?);
        #[cfg(windows)]
        return Ok({
            let _ = meta;
            true
        });
    }

    /// `meta`, of a folder, is this user's and closed to everyone else.
    pub fn closed(meta: &std::fs::Metadata) -> std::io::Result<bool> {
        #[cfg(unix)]
        return Ok(mine(meta)? && meta.permissions().mode() & 0o077 == 0);
        #[cfg(windows)]
        return mine(meta);
    }
}

/// Makes `dir` if needed, and checks it is a real folder (not a link) that only this user can open.
fn private_dir(dir: &Path) -> Result<(), CaptureError> {
    let io = |e: std::io::Error| failed("Couldn't make a private folder for attachments", e);
    match private::create_dir(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(io(e)),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(io)?;
    if !meta.is_dir() || !private::closed(&meta).map_err(io)? {
        return Err(CaptureError::Failed(format!("Couldn't save the file: {} isn't a private folder.", dir.display())));
    }
    Ok(())
}

/// A private cache folder, durable across app restarts so a failed message can still be retried with its attachments.
pub fn default_root() -> Result<PathBuf, CaptureError> {
    #[cfg(unix)]
    let cache = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")));
    #[cfg(windows)]
    let cache = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute());
    let cache = cache.ok_or_else(|| CaptureError::Failed("Couldn't find a folder for attachments.".into()))?;
    std::fs::create_dir_all(&cache).map_err(|e| failed("Couldn't open the cache folder", e))?;
    Ok(cache.join("hermes-chat").join("captures"))
}

/// A staged image's file name without its extension: the name the app gave it (`still`, `annotation-<n>`), if it is
/// plain enough.
pub fn capture_stem(name: &str) -> String {
    let ok = !name.is_empty() && name.len() <= 100 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        name.trim_end_matches(".png").to_owned()
    } else {
        "screenshot".to_owned()
    }
}

/// What a file holds, by its first bytes: the extension to give it, if it is an image the composer can preview.
pub fn image_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else {
        None
    }
}

impl Captures {
    /// Opens the captures folder at `root`, private to this user, with a subfolder for this process.
    pub fn open(root: PathBuf) -> Result<Captures, CaptureError> {
        if let Some(parent) = root.parent() {
            private_dir(parent)?;
        }
        private_dir(&root)?;
        let mine = root.join(std::process::id().to_string());
        Ok(Captures { root, mine, next: AtomicU64::new(0), retained: Mutex::new(HashSet::new()) })
    }

    /// This process's folder.
    pub fn mine(&self) -> &Path {
        &self.mine
    }

    /// A fresh path for a capture named `file_name`, in a private folder of its own, so names never clash.
    pub fn slot(&self, file_name: &str) -> Result<PathBuf, CaptureError> {
        private_dir(&self.mine)?;
        loop {
            let dir = self.mine.join(self.next.fetch_add(1, Ordering::Relaxed).to_string());
            // A reused pid may still own a file in a persisted outbox. Never overwrite an existing slot.
            match private::create_dir(&dir) {
                Ok(()) => return Ok(dir.join(file_name)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(failed("Couldn't save the file", e)),
            }
        }
    }

    /// Writes an image the app made into a slot, as `<name>.png` (or `.jpg`), readable only by this user.
    pub fn write(&self, name: &str, bytes: &[u8]) -> Result<PathBuf, CaptureError> {
        use std::io::Write;
        let ext = image_ext(bytes).ok_or_else(|| CaptureError::Failed("The image isn't a PNG or JPEG.".into()))?;
        let path = self.slot(&format!("{}.{ext}", capture_stem(name)))?;
        let written = (|| -> std::io::Result<()> {
            let mut to = private::create_file(&path)?;
            to.write_all(bytes)?;
            to.sync_all()
        })();
        if let Err(e) = written {
            self.discard(&path);
            return Err(failed("Couldn't save the file", e));
        }
        Ok(path)
    }

    /// `path` is a capture this process staged. Only names inside its own folder count, so the webview can't use
    /// discarding to delete anything else.
    pub fn owns(&self, path: &Path) -> bool {
        path.is_absolute()
            && path.parent().and_then(Path::parent) == Some(self.mine.as_path())
            && !path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
    }

    /// Checks every storage ancestor before traversal or deletion. In particular, a pid folder supplied by the
    /// filesystem or a persisted outbox must never redirect cleanup through a symlink outside capture storage.
    fn real_storage_dir(&self, dir: &Path) -> bool {
        let Ok(relative) = dir.strip_prefix(&self.root) else {
            return false;
        };
        let mut current = self.root.clone();
        let real_dir = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir());
        if !self.root.parent().is_some_and(real_dir) || !real_dir(&current) {
            return false;
        }
        for component in relative.components() {
            if !matches!(component, std::path::Component::Normal(_)) {
                return false;
            }
            current.push(component);
            if !real_dir(&current) {
                return false;
            }
        }
        true
    }

    /// Deletes a staged capture and its folder. Anything else is left alone; returns whether it was one.
    pub fn discard(&self, path: &Path) -> bool {
        if !self.owns(path) || !self.real_storage_dir(&self.mine) {
            return false;
        }
        // Held while deleting, so an outbox sync on another thread can't keep this path between the check and the delete.
        let retained = self.retained.locked();
        if retained.contains(path) {
            return false;
        }
        if let Some(dir) = path.parent().filter(|dir| self.real_storage_dir(dir)) {
            let _ = std::fs::remove_dir_all(dir);
        }
        true
    }

    /// Tracks every connection's outbox. Previously retained captures go once no message needs them.
    pub fn retain_outbox(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let valid = |p: &PathBuf| {
            p.is_absolute()
                && p.parent().and_then(Path::parent).and_then(Path::parent) == Some(self.root.as_path())
                && p.parent().is_some_and(|slot| self.real_storage_dir(slot))
                && !p.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
        };
        let next: HashSet<PathBuf> = paths.into_iter().filter(valid).collect();
        let mut retained = self.retained.locked();
        for path in retained.difference(&next) {
            if let Some(slot) = path.parent().filter(|slot| self.real_storage_dir(slot)) {
                let _ = std::fs::remove_dir_all(slot);
            }
        }
        *retained = next;
        drop(retained);
        self.sweep();
    }

    fn clear_instance(&self, dir: &Path) {
        if !self.real_storage_dir(dir) {
            return;
        }
        let retained = self.retained.locked();
        let Ok(slots) = std::fs::read_dir(dir) else {
            return;
        };
        for slot in slots.flatten() {
            if !retained.iter().any(|p| p.parent() == Some(slot.path().as_path())) {
                let _ = std::fs::remove_dir_all(slot.path());
            }
        }
        let _ = std::fs::remove_dir(dir);
    }

    /// Explicitly clears this process's unretained captures. Never call at exit: renderer outbox persistence can
    /// precede its retention IPC, so startup must reconcile persisted references before removing leftovers.
    pub fn clear(&self) {
        self.clear_instance(&self.mine);
    }

    /// Deletes unreferenced captures from dead instances after the renderer supplies the persisted outboxes.
    pub fn sweep(&self) {
        self.sweep_except(instance_alive);
    }

    pub fn sweep_except(&self, alive: impl Fn(u32) -> bool) {
        if !self.real_storage_dir(&self.root) {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name();
            let Some(pid) = name.to_str().and_then(|n| n.parse::<u32>().ok()) else {
                continue;
            };
            if pid != std::process::id() && !alive(pid) {
                self.clear_instance(&e.path());
            }
        }
    }
}

/// `pid` is a running Hermes Chat: it exists, isn't a zombie, and has this program's name. A pid reused by another
/// program, or one never reaped, doesn't keep a crashed run's captures around.
#[cfg(unix)]
pub fn instance_alive(pid: u32) -> bool {
    let proc = Path::new("/proc").join(pid.to_string());
    let Ok(stat) = std::fs::read_to_string(proc.join("stat")) else {
        return false;
    };
    // The state follows the name in parentheses, which can itself hold spaces or parentheses.
    let state = stat.rsplit_once(") ").and_then(|(_, rest)| rest.chars().next());
    if matches!(state, None | Some('Z') | Some('X')) {
        return false;
    }
    let comm = |p: &Path| std::fs::read_to_string(p.join("comm")).map(|c| c.trim_end().to_owned());
    matches!((comm(&proc), comm(Path::new("/proc/self"))), (Ok(a), Ok(b)) if a == b)
}

/// `pid` is a running Hermes Chat: it hasn't exited, and its program file has this one's name. A pid reused by another
/// program doesn't keep a crashed run's captures around.
#[cfg(windows)]
pub fn instance_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Some(me) = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_ascii_lowercase())) else {
        return false;
    };
    // SAFETY: the handle is checked before use and closed once; the name buffer's length is passed with it.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut code = 0u32;
        let running = GetExitCodeProcess(process, &mut code) != 0 && code == STILL_ACTIVE as u32;
        let mut name = [0u16; 1024];
        let mut len = name.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, name.as_mut_ptr(), &mut len) != 0;
        CloseHandle(process);
        if !(running && named) {
            return false;
        }
        let path = PathBuf::from(String::from_utf16_lossy(&name[..len as usize]));
        path.file_name().is_some_and(|n| n.to_ascii_lowercase() == me)
    }
}
