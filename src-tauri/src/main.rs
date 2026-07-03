// Desktop launcher. Mobile targets don't use this — they call `mast_lib::run`
// through the `mobile_entry_point` in lib.rs. The attribute hides the console
// window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mast_lib::run()
}
