// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The release's clean-install test builds the reference cable clip through the app, without a window.
    let mut args = std::env::args_os().skip(1);
    if args.next().is_some_and(|flag| flag == "--cad-self-test") {
        std::process::exit(materialize_3d_lib::fabrication::kinds::part::self_test::main(args.next().as_deref()));
    }
    materialize_3d_lib::run()
}
