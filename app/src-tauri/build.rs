fn main() {
    // The app's own commands, each with an allow- permission for
    // capabilities/ to grant.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["set_on_top", "own_title_bar"]),
        ),
    )
    .expect("tauri-build failed");
}
