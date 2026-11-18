//! `hermes-chat --stop` is the panic Stop (ADR 0221): it asks the running app to stop every reply using the Bot Desktop
//! and to take the screen, so Hermes's next `computer_use` call is refused until the owner hands it back. It reaches
//! the app as `Request::Stop` (remote.rs), as a chat link does; with none running, the app starts and does it once it
//! is signed in.
//!
//! A link is taken once by an inbox that outlives the sign-in screen (links.rs). A Stop needs a signed-in window, so it
//! waits here until one has started it, and an acknowledgement, not a read, ends it (src/hermes/tauriStop.ts).

use crate::lock::Locked;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

/// Tells the window a Stop is waiting (`stop_pending_request`).
pub const EVENT: &str = "stop-requested";

/// A Stop older than this is dropped unhandled: a window signed in minutes later shouldn't take the screen.
const STALE: Duration = Duration::from_secs(120);

/// The Stop waiting for a signed-in window. IDs let an acknowledgement leave a newer Stop alone.
#[derive(Default)]
pub struct Stops {
    next: AtomicU64,
    pending: Mutex<Option<(u64, Instant)>>,
}

impl Stops {
    pub fn ask(&self) {
        *self.pending.locked() = Some((self.next.fetch_add(1, Ordering::Relaxed), Instant::now()));
    }

    /// The waiting Stop's ID. Peeking leaves it waiting, in case the window goes away before handling it.
    pub fn pending(&self) -> Option<u64> {
        self.pending_at(Instant::now())
    }

    fn pending_at(&self, now: Instant) -> Option<u64> {
        let mut pending = self.pending.locked();
        if pending.is_some_and(|(_, at)| now.duration_since(at) >= STALE) {
            *pending = None;
        }
        pending.map(|(id, _)| id)
    }

    /// A live window started this Stop. A newer one stays waiting.
    pub fn acknowledge(&self, id: u64) {
        let mut pending = self.pending.locked();
        if pending.is_some_and(|(current, _)| current == id) {
            *pending = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peeking_preserves_a_stop_until_a_live_window_acknowledges_it() {
        let stops = Stops::default();
        stops.ask();
        let first = stops.pending().unwrap();
        assert_eq!(stops.pending(), Some(first));
        stops.ask();
        let second = stops.pending().unwrap();
        assert_ne!(first, second);
        stops.acknowledge(first);
        assert_eq!(stops.pending(), Some(second));
        stops.acknowledge(second);
        assert_eq!(stops.pending(), None);
    }

    #[test]
    fn an_unhandled_stop_expires_after_two_minutes() {
        let stops = Stops::default();
        stops.ask();
        assert!(stops.pending_at(Instant::now() + Duration::from_secs(119)).is_some());
        assert_eq!(stops.pending_at(Instant::now() + STALE), None);
    }
}
