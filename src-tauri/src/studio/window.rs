//! The names Rust and the window share: window labels, the dev server, the `m3dfile://` scheme, a pop out's page
//! address, and the TypeScript copy of what the commands return. `src/studio/api.ts` is the window's side. The tests
//! here read it, and the config files, so a name changed on one side alone fails a test.

/// The main window. `tauri.conf.json` declares it, and `capabilities/default.json` grants it every command.
pub const MAIN: &str = "main";

/// The start of each pop out window's label. `capabilities/pop-out.json` grants these windows one command.
pub const POP_OUT_PREFIX: &str = "pop-out-";

/// The dev server a debug app loads the window from, as `devUrl` in `tauri.conf.json` and the port in `vite.config.ts`
/// name it.
pub const DEV_ORIGIN: &str = "http://localhost:1420";

/// The scheme that serves project files. Each project is its own host.
pub const FILE_SCHEME: &str = "m3dfile";

/// The query keys of a pop out's page address: the project, the file in it, and the file's version.
pub const POP_OUT_KEYS: [&str; 3] = ["project", "rel", "v"];

#[cfg(test)]
pub(crate) mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::Path;

    use ts_rs::{Config, TypeVisitor, TS};

    use super::*;

    pub(crate) const API_TS: &str = include_str!("../../../src/studio/api.ts");

    /// The text between each pair of `quote` marks.
    pub(crate) fn quoted(text: &str, quote: char) -> BTreeSet<String> {
        text.split(quote).skip(1).step_by(2).map(str::to_owned).collect()
    }

    /// The text from `start` up to the next `end`.
    pub(crate) fn block<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).unwrap_or_else(|| panic!("no {start:?}")) + start.len();
        &text[from..from + text[from..].find(end).unwrap_or_else(|| panic!("no {end:?} after {start:?}"))]
    }

    #[test]
    fn the_window_hears_each_event_rust_sends_by_its_name() {
        let window = quoted(block(API_TS, "interface Events {", "}"), '\'');
        let rust = [crate::sidecar::EVENT, super::super::quit::FLUSH, crate::updater::PROGRESS_EVENT, crate::updater::WAITING_EVENT];
        assert_eq!(window, rust.map(str::to_owned).into(), "src/studio/api.ts Events");
    }

    #[test]
    fn the_dev_server_is_where_the_config_files_put_it() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).expect("json");
        assert_eq!(conf["build"]["devUrl"], DEV_ORIGIN, "tauri.conf.json devUrl");
        let port = DEV_ORIGIN.rsplit(':').next().expect("a port");
        assert!(include_str!("../../../vite.config.ts").contains(&format!("port: {port},")), "vite.config.ts serves on {port}");
    }

    #[test]
    fn the_window_builds_file_addresses_and_reads_pop_out_pages_by_the_same_names() {
        assert!(API_TS.contains(&format!("const FILE_SCHEME = '{FILE_SCHEME}'")), "src/studio/api.ts FILE_SCHEME");
        let keys = block(include_str!("../../../src/studio/PopOut.tsx"), "const KEYS = {", "}");
        let [project, rel, version] = POP_OUT_KEYS;
        for field in [format!("project: '{project}'"), format!("rel: '{rel}'"), format!("version: '{version}'")] {
            assert!(keys.contains(&field), "src/studio/PopOut.tsx KEYS has no {field}");
        }
    }

    /// Every type the window reads from a command or event, with the types it names. `Plate` declares none, as the
    /// window's list in `sidecar/src/protocol.ts` owns it.
    fn generated_types() -> String {
        struct Decls<'a> {
            cfg: &'a Config,
            out: BTreeMap<String, String>,
        }
        impl TypeVisitor for Decls<'_> {
            fn visit<T: TS + 'static + ?Sized>(&mut self) {
                if T::output_path().is_some() && !self.out.contains_key(&T::ident(self.cfg)) {
                    self.out.insert(T::ident(self.cfg), T::decl(self.cfg));
                    T::visit_dependencies(self);
                }
            }
        }
        // The window's numbers are JavaScript numbers. A file's size or time in milliseconds stays far below 2^53.
        let cfg = Config::new().with_large_int("number");
        let mut decls = Decls { cfg: &cfg, out: BTreeMap::new() };
        decls.visit::<super::super::setup::SlicerCheck>();
        decls.visit::<super::super::files::ProjectFile>();
        decls.visit::<crate::bambu::last_used::LastUsed>();
        decls.visit::<crate::bambu::PrinterChoice>();
        decls.visit::<crate::updater::UpdateCheck>();
        decls.visit::<crate::updater::Progress>();
        let mut out = String::from(concat!(
            "// Written from the Rust types by `generated_types_match_the_window_copy` in src-tauri/src/studio/window.rs.\n",
            "// Do not edit. To write it again, run `M3D_WRITE_TYPES=1 cargo test --lib generated_types` in src-tauri.\n",
            "import type { Plate } from '../../sidecar/src/protocol'\n",
        ));
        for decl in decls.out.values() {
            out.push_str("\nexport ");
            out.push_str(decl);
            out.push('\n');
        }
        out
    }

    #[test]
    fn generated_types_match_the_window_copy() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/studio/native-types.ts");
        let generated = generated_types();
        if std::env::var_os("M3D_WRITE_TYPES").is_some() {
            std::fs::write(&path, &generated).expect("write the window's types");
        }
        let committed = std::fs::read_to_string(&path).expect("read the window's types");
        assert_eq!(committed, generated, "src/studio/native-types.ts is out of date. Run `M3D_WRITE_TYPES=1 cargo test --lib generated_types` in src-tauri.");
    }
}
