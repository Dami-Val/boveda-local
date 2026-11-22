// Sin ventana de consola en la versión final.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    boveda_lib::run()
}
