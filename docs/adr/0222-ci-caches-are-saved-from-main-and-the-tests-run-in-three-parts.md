# CI caches are saved from main and the tests run in three parts

A pull request waited a median of 19.9 minutes for its checks (25 commits, November 2026), and one in ten waited 26.8 or more. Four causes made up most of it. `ci.yml` ran the whole Vitest suite twice in a row. Half the Ubuntu package installs stalled on the mirror for 10 to 24 minutes. The Windows and installer jobs missed the Rust cache in 13 of 15 runs. And one job ran the suite's 783 test-seconds on a single runner. This ADR records the rules that replace those.

## Caches are saved only from main

GitHub lets a pull request restore caches made on its own ref or on `main`, never another pull request's. A cache saved from a pull request helps only that pull request's next push, while it counts against the repository's 10 GB and pushes out caches that every pull request could use. So every `Swatinem/rust-cache` step has `save-if: github.ref == 'refs/heads/main'`, and `apt-install` saves only on `main`.

`installers` used to run only on pull requests and tags, so `main` never had its Windows or release caches. It now also runs on `main` when `Cargo.lock`, `Cargo.toml` or the CI files change, and every Monday, which picks up a new stable Rust. Rust-cache restores the newest cache that shares its prefix when the lockfile no longer matches, so a pull request that changes a crate still starts from most of the build. `windows-smoke` shares the `nsis` key and needs no run of its own on `main`.

## Ubuntu packages come from cached .deb files

`.github/actions/apt-install` points apt's archive folder at a cached directory, so the mirror is asked only for the package lists and any package newer than the cache. The key is the runner image, a hash of the package list and the ISO week. A new week misses the exact key, restores the last one, downloads what changed and saves again, and `apt-get autoclean` drops versions the mirror no longer serves. Each job keeps its own package list, and so its own cache.

## The suite runs in three parts, and `frontend` waits for them

`test (1/3)` to `test (3/3)` each run `vitest run --shard=n/3`. Vitest divides the files, and each test runs in exactly one part. Locally, at three workers, the parts took 116, 111 and 90 seconds against 270 for the whole suite. `frontend` needs all three and fails unless they all succeeded, so the required check named `frontend` still means the tests passed. It runs the build and the other checks after that.

## The Windows relay test runs where its build already is

`other-account.ps1` runs one ignored test from the debug test build. It moved from the `nsis` job, where it compiled that build from nothing before the release build, to the Windows `rust` job, right after `cargo test --lib --tests` made it with the same `RUSTFLAGS`.

## Rejected

- **Saving caches from pull requests as well.** No other pull request can restore them, and they evict the ones it can.
- **A third-party apt cache action.** The common one caches unpacked files and by default skips the packages' install scripts, which `dbus` and `fuse3` need. Caching the .deb files keeps apt's own install.
- **Choosing which tests run from the diff, by an agent or by `vitest --changed`.** A selection that can miss a test can't gate a merge, and the whole suite in three parts takes about two minutes.
