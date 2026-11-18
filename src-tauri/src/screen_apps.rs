//! Puts a terminal and a text editor on the Screen's Bot Desktop, and `xclip` for copying out of it (ADR 0193). Hermes
//! installs neither `mousepad`, `xclip` nor, on a server where its own desktop install wasn't used, `xfce4-terminal`,
//! and they need root. So the app installs them through the owner's own `ssh`.
//!
//! The remote command is a constant, `screen_apps.sh`: nothing in it comes from the webview. The only thing the owner
//! types, a sudo password, goes on ssh's stdin, which `sudo -S` reads. It is never an argument, so it never shows in a
//! process list on either machine, and it is not logged or kept.

use crate::ssh_guard::{self, Kind, Target};
use serde::Serialize;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// The install, as the owner could paste it too (src/hermes/screenApps.ts reads the same file). It exits 10 when sudo
/// needs a password and none was given, 3 with no package manager it knows, and 4 with no sudo.
pub const SCRIPT: &str = include_str!("screen_apps.sh");

/// A package manager that has to fetch its lists first can take a while on a slow mirror.
const LIMIT: Duration = Duration::from_secs(15 * 60);

/// How the install went. Serialized with `kind` in kebab case, as `SystemOutcome` in src/hermes/screenApps.ts.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Outcome {
    Installed,
    /// The server's sudo asks for a password, and none was given.
    NeedsPassword,
    WrongPassword,
    NoPackageManager,
    NoSudo,
    /// The package manager failed: the last lines it printed.
    Failed {
        output: String,
    },
    /// It didn't run, or how it ended isn't known: ssh couldn't get in, or no answer in time.
    Error {
        message: String,
    },
}

/// The script as one line, so a remote login shell that isn't POSIX (csh) reads it as one quoted argument. Each line
/// of the script is a whole command, so joining them with `; ` keeps its meaning.
pub fn one_line() -> String {
    SCRIPT.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("; ")
}

/// The script's first argument: whether a password waits on stdin.
fn mode(password_given: bool) -> &'static str {
    if password_given {
        "password"
    } else {
        "ask"
    }
}

const BAD_TARGET: &str = "Enter an SSH target such as lena@hermes or a host alias from ~/.ssh/config.";

/// `ssh` to `target`, running the script, or None for a target that isn't one. The password, if any, is not passed here.
pub fn ssh_command(target: &str, password_given: bool) -> Option<Command> {
    let target = Target::parse(target)?;
    let remote = format!("exec sh -c '{}' highwing-screen-apps {}", one_line(), mode(password_given));
    let mut command = crate::tunnel::background_ssh();
    command.args(ssh_guard::args(target, Kind::Command { remote: &[&remote] }, Some(Duration::from_secs(15))));
    Some(command)
}

/// What ssh's own failure (exit status 255) was about, from what it printed, in the owner's words.
fn ssh_failure(stderr: &str) -> &'static str {
    let s = stderr.to_ascii_lowercase();
    if s.contains("host key verification failed") || s.contains("remote host identification has changed") {
        "ssh doesn't know this server's host key yet. Connect once from the Terminal and accept it, then try again."
    } else if s.contains("permission denied") || s.contains("too many authentication failures") {
        "ssh couldn't sign in to the server without asking. The key needs to be in your SSH agent, or unencrypted."
    } else if s.contains("could not resolve")
        || s.contains("connection refused")
        || s.contains("connection timed out")
        || s.contains("no route to host")
        || s.contains("network is unreachable")
        || s.contains("operation timed out")
    {
        "ssh couldn't reach the server."
    } else {
        "ssh failed."
    }
}

/// What the script's exit `code` and output mean.
pub fn outcome(code: Option<i32>, stdout: &str, stderr: &str) -> Outcome {
    let said = stderr.to_ascii_lowercase();
    match code {
        Some(0) => Outcome::Installed,
        Some(10) => Outcome::NeedsPassword,
        Some(3) => Outcome::NoPackageManager,
        Some(4) => Outcome::NoSudo,
        Some(255) => Outcome::Error { message: ssh_failure(stderr).into() },
        _ if said.contains("incorrect password") || said.contains("sorry, try again") => Outcome::WrongPassword,
        _ => Outcome::Failed { output: last_lines(if stderr.trim().is_empty() { stdout } else { stderr }, 8) },
    }
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Runs `command` (ssh, or in tests the script itself), with `password` and a newline on its stdin.
pub async fn run(mut command: Command, password: Option<&str>) -> Outcome {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::Error { message: format!("Couldn't start ssh: {e}") },
    };
    let mut stdin = child.stdin.take().expect("piped stdin");
    if let Some(p) = password {
        // A script that exits before reading (root, or sudo without a password) closes its end early.
        let _ = stdin.write_all(format!("{p}\n").as_bytes()).await;
    }
    drop(stdin);
    match tokio::time::timeout(LIMIT, child.wait_with_output()).await {
        Err(_) => Outcome::Error { message: format!("The server didn't answer within {} s.", LIMIT.as_secs()) },
        Ok(Err(e)) => Outcome::Error { message: format!("Couldn't start ssh: {e}") },
        Ok(Ok(out)) => outcome(out.status.code(), &String::from_utf8_lossy(&out.stdout), &String::from_utf8_lossy(&out.stderr)),
    }
}

/// Installs them on the server `target` reaches.
pub async fn install_over_ssh(target: &str, password: Option<&str>) -> Outcome {
    match ssh_command(target, password.is_some()) {
        Some(command) => run(command, password).await,
        None => Outcome::Error { message: BAD_TARGET.into() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_fits_in_single_quotes_and_is_the_same_every_time() {
        assert!(!SCRIPT.contains('\''), "the remote command wraps the script in single quotes");
        assert!(!one_line().contains('\n'));
        let cmd = ssh_command("lena@hermes", false).unwrap();
        let args: Vec<_> = cmd.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        let dashdash = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(args[dashdash + 1], "lena@hermes");
        assert_eq!(args[dashdash + 2], format!("exec sh -c '{}' highwing-screen-apps ask", one_line()));
        assert_eq!(args.len(), dashdash + 3);
        assert!(args.windows(2).any(|w| w == ["-o", "BatchMode=yes"]));
        let with_password = ssh_command("lena@hermes", true).unwrap();
        let last = with_password.as_std().get_args().last().unwrap().to_string_lossy().into_owned();
        assert!(last.ends_with("highwing-screen-apps password"));
        assert!(ssh_command("-oProxyCommand=x", false).is_none());
    }

    #[test]
    fn reads_how_the_install_ended() {
        assert_eq!(outcome(Some(0), "", ""), Outcome::Installed);
        assert_eq!(outcome(Some(10), "", ""), Outcome::NeedsPassword);
        assert_eq!(outcome(Some(3), "", "no apt-get, dnf or pacman on the server"), Outcome::NoPackageManager);
        assert_eq!(outcome(Some(4), "", "the server has no sudo"), Outcome::NoSudo);
        assert_eq!(outcome(Some(1), "", "Sorry, try again.\nsudo: 1 incorrect password attempt\n"), Outcome::WrongPassword);
        assert_eq!(
            outcome(Some(255), "", "ssh: connect to host hermes port 22: Connection refused"),
            Outcome::Error { message: "ssh couldn't reach the server.".into() }
        );
        let Outcome::Error { message } = outcome(Some(255), "", "lena@hermes: Permission denied (publickey).") else { panic!("an ssh failure") };
        assert!(message.starts_with("ssh couldn't sign in"));
        let Outcome::Error { message } = outcome(Some(255), "", "Host key verification failed.") else { panic!("an ssh failure") };
        assert!(message.starts_with("ssh doesn't know this server's host key"));
        let apt = "Reading package lists...\n\n".to_owned()
            + &(1..=10).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n")
            + "\nE: Unable to locate package mousepad\n";
        let Outcome::Failed { output } = outcome(Some(100), "", &apt) else { panic!("a failed install") };
        assert_eq!(output.lines().count(), 8);
        assert_eq!(output.lines().last(), Some("E: Unable to locate package mousepad"));
        assert_eq!(outcome(Some(1), "only on stdout\n", ""), Outcome::Failed { output: "only on stdout".into() });
        assert_eq!(outcome(None, "", "Killed"), Outcome::Failed { output: "Killed".into() });
    }

    /// A server of stand-ins on an empty PATH: `id`, `sudo` and a package manager, each a script.
    #[cfg(unix)]
    struct Server {
        dir: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl Server {
        fn new(name: &str, programs: &[(&str, &str)]) -> Server {
            use std::os::unix::fs::PermissionsExt;
            let dir = std::env::temp_dir().join(format!("hermes-screen-apps-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::os::unix::fs::symlink("/bin/sh", dir.join("sh")).unwrap();
            for (program, body) in programs {
                let path = dir.join(program);
                std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            Server { dir }
        }

        fn log(&self) -> String {
            std::fs::read_to_string(self.dir.join("log")).unwrap_or_default()
        }

        async fn install(&self, password: Option<&str>) -> Outcome {
            let mut command = Command::new("/bin/sh");
            command
                .args(["-c", &one_line(), "highwing-screen-apps", mode(password.is_some())])
                .env_clear()
                .env("PATH", &self.dir)
                .env("LOG", self.dir.join("log"));
            run(command, password).await
        }
    }

    #[cfg(unix)]
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[cfg(unix)]
    const APT: (&str, &str) = ("apt-get", r#"echo "apt-get $* as $(id -u)" >> "$LOG""#);
    #[cfg(unix)]
    const USER: (&str, &str) = ("id", "echo ${AS:-1000}");
    /// sudo with a password of `hunter2`: `-n` works only once it has been typed, as `AS=0`.
    #[cfg(unix)]
    const SUDO: (&str, &str) = (
        "sudo",
        r#"if [ "$1" = -n ]; then [ "$2" = true ] && exit 1; shift; AS=0 exec "$@"; fi
if [ "$1" = -S ]; then shift 3; IFS= read -r pw; [ "$pw" = hunter2 ] && AS=0 exec "$@"; echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1; fi
exit 2"#,
    );

    #[cfg(unix)]
    #[tokio::test]
    async fn installs_as_root_without_asking() {
        let s = Server::new("root", &[APT, ("id", "echo 0")]);
        assert_eq!(s.install(None).await, Outcome::Installed);
        assert_eq!(s.log(), "apt-get install -y --no-install-recommends xfce4-terminal mousepad xclip as 0\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn installs_through_sudo_without_a_password_when_sudo_needs_none() {
        let s = Server::new("nopasswd", &[APT, USER, ("sudo", r#"[ "$1" = -n ] || exit 2; shift; [ "$1" = true ] && exit 0; AS=0 exec "$@""#)]);
        assert_eq!(s.install(None).await, Outcome::Installed);
        assert_eq!(s.log(), "apt-get install -y --no-install-recommends xfce4-terminal mousepad xclip as 0\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn asks_for_the_password_and_takes_it_on_stdin() {
        let s = Server::new("password", &[APT, USER, SUDO]);
        assert_eq!(s.install(None).await, Outcome::NeedsPassword);
        assert_eq!(s.log(), "", "nothing ran before the password");
        assert_eq!(s.install(Some("wrong")).await, Outcome::WrongPassword);
        assert_eq!(s.log(), "");
        assert_eq!(s.install(Some("hunter2")).await, Outcome::Installed);
        assert_eq!(s.log(), "apt-get install -y --no-install-recommends xfce4-terminal mousepad xclip as 0\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fetches_the_package_lists_when_the_first_try_fails() {
        let apt = (
            "apt-get",
            r#"echo "apt-get $*" >> "$LOG"; [ "$1" = update ] && { : > "$LOG.updated"; exit 0; }; [ -e "$LOG.updated" ] || { echo "E: Unable to locate package mousepad" >&2; exit 100; }"#,
        );
        let s = Server::new("update", &[apt, ("id", "echo 0")]);
        assert_eq!(s.install(None).await, Outcome::Installed);
        assert_eq!(
            s.log().lines().collect::<Vec<_>>(),
            [
                "apt-get install -y --no-install-recommends xfce4-terminal mousepad xclip",
                "apt-get update",
                "apt-get install -y --no-install-recommends xfce4-terminal mousepad xclip"
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn says_what_the_server_lacks() {
        assert_eq!(Server::new("nopm", &[USER]).install(None).await, Outcome::NoPackageManager);
        assert_eq!(Server::new("nosudo", &[APT, USER]).install(None).await, Outcome::NoSudo);
        let pacman = ("pacman", "echo 'error: target not found: mousepad' >&2; exit 1");
        assert_eq!(
            Server::new("pacman", &[pacman, ("id", "echo 0")]).install(None).await,
            Outcome::Failed { output: "error: target not found: mousepad".into() }
        );
    }
}
