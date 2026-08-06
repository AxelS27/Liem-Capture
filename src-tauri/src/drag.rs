#[cfg(target_os = "windows")]
use std::sync::mpsc;
use tauri::{command, AppHandle};

/// Sweeps `%TEMP%\liem-cap2-drag\` and deletes any leftover drag temporary files
/// from previous sessions. Called during application setup.
pub fn cleanup_drag_temp_dir() {
    let drag_dir = std::env::temp_dir().join("liem-cap2-drag");
    if drag_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&drag_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }
}

/// Result of a drag operation. `true` means the user actually dropped onto a
/// target (Discord, Explorer, a browser…); `false` means the drag was
/// cancelled (Esc, drop on empty area, drop on a non-accepting window).
#[command]
pub fn start_drag(app: AppHandle, path: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let _ = app;
        if !std::path::Path::new(&path).is_file() {
            return Err(format!("Drag source file not found: {path}"));
        }

        let drag_dir = std::env::temp_dir().join("liem-cap2-drag");
        std::fs::create_dir_all(&drag_dir).map_err(|e| e.to_string())?;

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let temp_path = drag_dir.join(format!("capture-{timestamp}.png"));

        std::fs::copy(&path, &temp_path)
            .map_err(|e| format!("Failed to copy capture for drag: {e}"))?;

        let temp_path_str = temp_path.to_string_lossy().to_string();

        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(windows_drag(&temp_path_str));
        });

        return rx
            .recv()
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, path);
        Ok(false)
    }
}

#[cfg(target_os = "windows")]
fn windows_drag(path: &str) -> Result<bool, String> {
    if !std::path::Path::new(path).is_file() {
        return Err(format!("Drag source file not found: {path}"));
    }

    use std::{cell::Cell, mem::ManuallyDrop, ptr};
    use windows::{
        core::{implement, Error, Result as WinResult, HRESULT},
        Win32::{
            Foundation::{
                BOOL, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS,
                DV_E_FORMATETC, E_NOTIMPL, E_POINTER, OLE_E_ADVISENOTSUPPORTED, POINT, S_FALSE,
            },
            System::{
                Com::{
                    IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC,
                    IEnumFORMATETC_Impl, IEnumSTATDATA, DATADIR_GET, DVASPECT_CONTENT, FORMATETC,
                    STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
                },
                Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
                Ole::{
                    DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
                    CF_HDROP, CF_UNICODETEXT, DROPEFFECT, DROPEFFECT_COPY,
                },
                SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            },
            UI::Shell::DROPFILES,
        },
    };

    fn format_etc(cf_format: u16) -> FORMATETC {
        FORMATETC {
            cfFormat: cf_format,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    #[implement(IEnumFORMATETC)]
    struct FormatEnumerator {
        index: Cell<usize>,
    }

    impl IEnumFORMATETC_Impl for FormatEnumerator_Impl {
        fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
            if rgelt.is_null() || (celt > 1 && pceltfetched.is_null()) {
                return E_POINTER;
            }

            let formats = [CF_HDROP.0, CF_UNICODETEXT.0];
            let mut fetched = 0u32;
            let mut cur = self.index.get();

            while cur < formats.len() && fetched < celt {
                unsafe {
                    ptr::write(rgelt.add(fetched as usize), format_etc(formats[cur]));
                }
                fetched += 1;
                cur += 1;
            }

            self.index.set(cur);

            unsafe {
                if !pceltfetched.is_null() {
                    *pceltfetched = fetched;
                }
            }

            if fetched == celt {
                HRESULT(0)
            } else {
                S_FALSE
            }
        }

        fn Skip(&self, celt: u32) -> WinResult<()> {
            let new_idx = (self.index.get() + celt as usize).min(2);
            self.index.set(new_idx);
            Ok(())
        }

        fn Reset(&self) -> WinResult<()> {
            self.index.set(0);
            Ok(())
        }

        fn Clone(&self) -> WinResult<IEnumFORMATETC> {
            Ok(IEnumFORMATETC::from(FormatEnumerator {
                index: Cell::new(self.index.get()),
            }))
        }
    }

    #[implement(IDataObject)]
    struct FileDragData {
        path: String,
    }

    impl FileDragData {
        fn supports(format: &FORMATETC) -> bool {
            (format.cfFormat == CF_HDROP.0 || format.cfFormat == CF_UNICODETEXT.0)
                && format.dwAspect == DVASPECT_CONTENT.0
                && (format.tymed & TYMED_HGLOBAL.0 as u32) != 0
        }

        unsafe fn hdrop_medium(&self) -> WinResult<STGMEDIUM> {
            let mut wide_path: Vec<u16> = self.path.encode_utf16().collect();
            wide_path.push(0);
            wide_path.push(0);

            let header_size = std::mem::size_of::<DROPFILES>();
            let byte_len = header_size + (wide_path.len() * std::mem::size_of::<u16>());
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, byte_len)?;
            let raw = GlobalLock(hglobal);

            if raw.is_null() {
                return Err(Error::from_win32());
            }

            ptr::write(
                raw as *mut DROPFILES,
                DROPFILES {
                    pFiles: header_size as u32,
                    pt: POINT { x: 0, y: 0 },
                    fNC: BOOL(0),
                    fWide: BOOL(1),
                },
            );

            ptr::copy_nonoverlapping(
                wide_path.as_ptr(),
                (raw as *mut u8).add(header_size) as *mut u16,
                wide_path.len(),
            );

            let _ = GlobalUnlock(hglobal);

            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: hglobal },
                pUnkForRelease: ManuallyDrop::new(None),
            })
        }

        unsafe fn unicode_text_medium(&self) -> WinResult<STGMEDIUM> {
            let mut wide_path: Vec<u16> = self.path.encode_utf16().collect();
            wide_path.push(0);

            let byte_len = wide_path.len() * std::mem::size_of::<u16>();
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, byte_len)?;
            let raw = GlobalLock(hglobal);

            if raw.is_null() {
                return Err(Error::from_win32());
            }

            ptr::copy_nonoverlapping(
                wide_path.as_ptr(),
                raw as *mut u16,
                wide_path.len(),
            );

            let _ = GlobalUnlock(hglobal);

            Ok(STGMEDIUM {
                tymed: TYMED_HGLOBAL.0 as u32,
                u: STGMEDIUM_0 { hGlobal: hglobal },
                pUnkForRelease: ManuallyDrop::new(None),
            })
        }
    }

    impl IDataObject_Impl for FileDragData_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
            unsafe {
                if pformatetcin.is_null() || !FileDragData::supports(&*pformatetcin) {
                    return Err(Error::from_hresult(DV_E_FORMATETC));
                }

                let fmt = &*pformatetcin;
                if fmt.cfFormat == CF_HDROP.0 {
                    self.hdrop_medium()
                } else if fmt.cfFormat == CF_UNICODETEXT.0 {
                    self.unicode_text_medium()
                } else {
                    Err(Error::from_hresult(DV_E_FORMATETC))
                }
            }
        }

        fn GetDataHere(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *mut STGMEDIUM,
        ) -> WinResult<()> {
            Err(Error::from_hresult(E_NOTIMPL))
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            unsafe {
                if !pformatetc.is_null() && FileDragData::supports(&*pformatetc) {
                    HRESULT(0)
                } else {
                    DV_E_FORMATETC
                }
            }
        }

        fn GetCanonicalFormatEtc(
            &self,
            _pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            unsafe {
                if !pformatetcout.is_null() {
                    (*pformatetcout).ptd = ptr::null_mut();
                }
            }
            S_FALSE
        }

        fn SetData(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *const STGMEDIUM,
            _frelease: BOOL,
        ) -> WinResult<()> {
            Err(Error::from_hresult(E_NOTIMPL))
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> WinResult<IEnumFORMATETC> {
            if dwdirection == DATADIR_GET.0 as u32 {
                Ok(IEnumFORMATETC::from(FormatEnumerator {
                    index: Cell::new(0),
                }))
            } else {
                Err(Error::from_hresult(DV_E_FORMATETC))
            }
        }

        fn DAdvise(
            &self,
            _pformatetc: *const FORMATETC,
            _advf: u32,
            _padvsink: Option<&IAdviseSink>,
        ) -> WinResult<u32> {
            Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }

        fn DUnadvise(&self, _dwconnection: u32) -> WinResult<()> {
            Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }

        fn EnumDAdvise(&self) -> WinResult<IEnumSTATDATA> {
            Err(Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }
    }

    #[implement(IDropSource)]
    struct FileDropSource;

    impl IDropSource_Impl for FileDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if fescapepressed.as_bool() {
                DRAGDROP_S_CANCEL
            } else if (grfkeystate & MK_LBUTTON).0 == 0 {
                DRAGDROP_S_DROP
            } else {
                HRESULT(0)
            }
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    unsafe {
        let ole_initialized = OleInitialize(None).is_ok();
        let data = IDataObject::from(FileDragData {
            path: path.to_string(),
        });
        let source = IDropSource::from(FileDropSource);
        let mut effect = DROPEFFECT(0);

        let hr = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect);

        if ole_initialized {
            OleUninitialize();
        }

        // DoDragDrop returns either DRAGDROP_S_DROP (dropped onto a target)
        // or DRAGDROP_S_CANCEL (user cancelled). Both are SUCCESS HRESULTs
        // so `.ok()` collapses the two — we have to compare the raw code
        // ourselves to tell the caller whether the file actually landed.
        if hr == DRAGDROP_S_DROP {
            Ok(true)
        } else if hr == DRAGDROP_S_CANCEL {
            Ok(false)
        } else if hr.is_ok() {
            // Unexpected success HRESULT — treat as cancel to be safe.
            Ok(false)
        } else {
            Err(format!("DoDragDrop failed: 0x{:08x}", hr.0 as u32))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn test_cleanup_drag_temp_dir() {
        let drag_dir = std::env::temp_dir().join("liem-cap2-drag");
        std::fs::create_dir_all(&drag_dir).unwrap();

        let dummy_file = drag_dir.join("capture-123456789.png");
        {
            let mut f = File::create(&dummy_file).unwrap();
            writeln!(f, "dummy data").unwrap();
        }
        assert!(dummy_file.exists());

        cleanup_drag_temp_dir();

        assert!(!dummy_file.exists());
    }
}
