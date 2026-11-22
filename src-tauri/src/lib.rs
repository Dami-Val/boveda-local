//! Parte nativa de Bóveda: guarda el archivo cifrado junto al ejecutable, Windows Hello,
//! abrir sitios y exportar. El cifrado ocurre en la interfaz (WebCrypto): aquí solo llegan datos cifrados,
//! salvo el CSV que el usuario pide exportar.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::{fs, path::PathBuf};
use tauri::Manager;

/// Los datos viven junto al ejecutable (versión portátil). `BOVEDA_DIR` solo para desarrollo y pruebas.
fn carpeta() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("BOVEDA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("El ejecutable no tiene carpeta")?.to_path_buf())
}

fn ruta(nombre: &str) -> Result<PathBuf, String> {
    Ok(carpeta()?.join(nombre))
}

const TEXTO_ERROR: fn(std::io::Error) -> String = |e| e.to_string();

#[tauri::command]
fn leer_boveda() -> Result<Option<String>, String> {
    let p = ruta("boveda.json")?;
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(p).map(Some).map_err(TEXTO_ERROR)
}

#[tauri::command]
fn guardar_boveda(contenido: String) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(&contenido).map_err(|_| "JSON inválido")?;
    for campo in ["salt", "iv", "data", "iter"] {
        if v.get(campo).is_none() {
            return Err(format!("Falta el campo {campo}"));
        }
    }
    let p = ruta("boveda.json")?;
    if p.exists() {
        fs::copy(&p, ruta("boveda.json.bak")?).map_err(TEXTO_ERROR)?; // versión anterior por si algo sale mal
    }
    let tmp = ruta("boveda.json.tmp")?;
    fs::write(&tmp, contenido).map_err(TEXTO_ERROR)?;
    fs::rename(&tmp, &p).map_err(TEXTO_ERROR) // atómico: reemplaza sin dejar un archivo a medias
}

#[tauri::command]
fn exportar_csv(app: tauri::AppHandle, contenido: String, nombre: String) -> Result<String, String> {
    if nombre.contains(['/', '\\']) || !nombre.ends_with(".csv") {
        return Err("Nombre de archivo inválido".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let base = nombre.trim_end_matches(".csv");
    let mut p = dir.join(&nombre);
    let mut n = 2;
    while p.exists() {
        p = dir.join(format!("{base} ({n}).csv"));
        n += 1;
    }
    fs::write(&p, contenido).map_err(TEXTO_ERROR)?;
    Ok(p.display().to_string())
}

/// Abre un sitio en el navegador predeterminado. Solo http(s): un CSV podría traer otros esquemas.
#[tauri::command]
fn abrir_url(url: String) -> Result<(), String> {
    let u = tauri::Url::parse(&url).map_err(|_| "URL inválida")?;
    if !matches!(u.scheme(), "http" | "https") {
        return Err("Solo se abren direcciones http o https".into());
    }
    tauri_plugin_opener::open_url(u.as_str(), None::<&str>).map_err(|e| e.to_string())
}

// ---------- Windows Hello ----------

#[tauri::command]
fn hello_estado() -> Result<bool, String> {
    Ok(cfg!(windows) && ruta("hello.dat")?.exists())
}

#[tauri::command]
fn hello_borrar() -> Result<(), String> {
    let p = ruta("hello.dat")?;
    if p.exists() {
        fs::remove_file(p).map_err(TEXTO_ERROR)?;
    }
    Ok(())
}

/// Pide Windows Hello y guarda la llave de la bóveda protegida con DPAPI (cuenta de Windows).
#[tauri::command]
async fn hello_activar(ventana: tauri::WebviewWindow, llave: String) -> Result<(), String> {
    let bytes = B64.decode(llave.as_bytes()).map_err(|_| "Llave inválida")?;
    if bytes.len() != 32 {
        return Err("Llave inválida".into());
    }
    let hwnd = identificador_ventana(&ventana)?;
    let cifrada = tauri::async_runtime::spawn_blocking(move || {
        hello::verificar(hwnd)?;
        hello::dpapi(&bytes, true)
    })
    .await
    .map_err(|e| e.to_string())??;
    fs::write(ruta("hello.dat")?, B64.encode(cifrada)).map_err(TEXTO_ERROR)
}

/// Pide Windows Hello y devuelve la llave de la bóveda.
#[tauri::command]
async fn hello_desbloquear(ventana: tauri::WebviewWindow) -> Result<String, String> {
    let guardada = fs::read_to_string(ruta("hello.dat")?).map_err(|_| "SinLlave")?;
    let cifrada = B64.decode(guardada.trim()).map_err(|_| "SinLlave")?;
    let hwnd = identificador_ventana(&ventana)?;
    let llave = tauri::async_runtime::spawn_blocking(move || {
        hello::verificar(hwnd)?;
        hello::dpapi(&cifrada, false)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(B64.encode(llave))
}

#[cfg(windows)]
fn identificador_ventana(ventana: &tauri::WebviewWindow) -> Result<isize, String> {
    Ok(ventana.hwnd().map_err(|e| e.to_string())?.0 as isize)
}

#[cfg(not(windows))]
fn identificador_ventana(_: &tauri::WebviewWindow) -> Result<isize, String> {
    Err("DeviceNotPresent".into())
}

#[cfg(windows)]
mod hello {
    use windows::{
        core::{factory, HSTRING, PCWSTR},
        Security::Credentials::UI::{UserConsentVerificationResult as R, UserConsentVerifier},
        Win32::{
            Foundation::{LocalFree, HLOCAL, HWND},
            Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
            System::WinRT::IUserConsentVerifierInterop,
        },
    };
    use windows_future::IAsyncOperation;

    /// El diálogo de Windows Hello se ancla a la ventana de la app para que aparezca al frente.
    pub fn verificar(hwnd: isize) -> Result<(), String> {
        let interop = factory::<UserConsentVerifier, IUserConsentVerifierInterop>().map_err(|e| e.message())?;
        let mensaje = HSTRING::from("Bóveda: confirma que eres tú");
        let operacion: IAsyncOperation<R> = unsafe { interop.RequestVerificationForWindowAsync(HWND(hwnd as _), &mensaje) }
            .map_err(|e| e.message())?;
        let resultado = operacion.get().map_err(|e| e.message())?;
        let motivo = match resultado {
            R::Verified => return Ok(()),
            R::DeviceNotPresent => "DeviceNotPresent",
            R::NotConfiguredForUser => "NotConfiguredForUser",
            R::DisabledByPolicy => "DisabledByPolicy",
            R::DeviceBusy => "DeviceBusy",
            R::RetriesExhausted => "RetriesExhausted",
            R::Canceled => "Canceled",
            _ => "Error",
        };
        Err(motivo.into())
    }

    /// Protege o recupera bytes con la cuenta de Windows del usuario (DPAPI).
    pub fn dpapi(datos: &[u8], proteger: bool) -> Result<Vec<u8>, String> {
        let entrada = CRYPT_INTEGER_BLOB { cbData: datos.len() as u32, pbData: datos.as_ptr() as *mut u8 };
        let mut salida = CRYPT_INTEGER_BLOB::default();
        unsafe {
            if proteger {
                CryptProtectData(&entrada, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut salida)
            } else {
                CryptUnprotectData(&entrada, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut salida)
            }
            .map_err(|e| e.message())?;
            let resultado = std::slice::from_raw_parts(salida.pbData, salida.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(salida.pbData as _)));
            Ok(resultado)
        }
    }
}

#[cfg(not(windows))]
mod hello {
    pub fn verificar(_: isize) -> Result<(), String> {
        Err("DeviceNotPresent".into())
    }
    pub fn dpapi(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
        Err("DeviceNotPresent".into())
    }
}

#[cfg(test)]
mod pruebas {
    use super::*;

    #[test]
    fn guardar_valida_respalda_y_lee() {
        let dir = std::env::temp_dir().join(format!("boveda-prueba-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        std::env::set_var("BOVEDA_DIR", &dir);

        assert_eq!(leer_boveda().unwrap(), None);
        assert!(guardar_boveda("no es json".into()).is_err());
        assert!(guardar_boveda(r#"{"salt":"a"}"#.into()).is_err());

        let v1 = r#"{"v":1,"iter":1000,"salt":"a","iv":"b","data":"uno"}"#;
        let v2 = r#"{"v":1,"iter":1000,"salt":"a","iv":"b","data":"dos"}"#;
        guardar_boveda(v1.into()).unwrap();
        guardar_boveda(v2.into()).unwrap();
        assert_eq!(leer_boveda().unwrap().as_deref(), Some(v2));
        assert_eq!(fs::read_to_string(dir.join("boveda.json.bak")).unwrap(), v1);
        assert!(!dir.join("boveda.json.tmp").exists());

        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_ida_y_vuelta() {
        let llave = [7u8; 32];
        let protegida = hello::dpapi(&llave, true).unwrap();
        assert_ne!(protegida, llave);
        assert_eq!(hello::dpapi(&protegida, false).unwrap(), llave);
        assert!(hello::dpapi(b"basura", false).is_err());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut app = tauri::Builder::default();
    // Una sola instancia: abrir el .exe de nuevo trae al frente la ventana que ya está abierta.
    #[cfg(desktop)]
    {
        app = app.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(ventana) = app.get_webview_window("main") {
                let _ = ventana.unminimize();
                let _ = ventana.set_focus();
            }
        }));
    }
    app.plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            leer_boveda,
            guardar_boveda,
            exportar_csv,
            abrir_url,
            hello_estado,
            hello_borrar,
            hello_activar,
            hello_desbloquear
        ])
        .run(tauri::generate_context!())
        .expect("No se pudo iniciar Bóveda");
}
