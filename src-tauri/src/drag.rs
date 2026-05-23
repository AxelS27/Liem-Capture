use std::sync::mpsc;
use tauri::{command, AppHandle};

#[command]
pub fn start_drag(app: AppHandle, path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(windows_drag(&path));
        })
        .map_err(|e| e.to_string())?;

        rx.recv()
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_drag(path: &str) -> Result<(), String> {
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
                    CF_HDROP, DROPEFFECT, DROPEFFECT_COPY,
                },
                SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            },
            UI::Shell::DROPFILES,
        },
    };

    fn hdrop_format() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    #[implement(IEnumFORMATETC)]
    struct FormatEnumerator {
        emitted: Cell<bool>,
    }

    impl IEnumFORMATETC_Impl for FormatEnumerator_Impl {
        fn Next(&self, celt: u32, rgelt: *mut FORMATETC, pceltfetched: *mut u32) -> HRESULT {
            if rgelt.is_null() || (celt > 1 && pceltfetched.is_null()) {
                return E_POINTER;
            }

            let mut fetched = 0;
            if celt > 0 && !self.emitted.get() {
                unsafe {
                    ptr::write(rgelt, hdrop_format());
                }
                self.emitted.set(true);
                fetched = 1;
            }

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
            if celt > 0 && !self.emitted.get() {
                self.emitted.set(true);
            }
            Ok(())
        }

        fn Reset(&self) -> WinResult<()> {
            self.emitted.set(false);
            Ok(())
        }

        fn Clone(&self) -> WinResult<IEnumFORMATETC> {
            Ok(IEnumFORMATETC::from(FormatEnumerator {
                emitted: Cell::new(self.emitted.get()),
            }))
        }
    }

    #[implement(IDataObject)]
    struct FileDragData {
        path: String,
    }

    impl FileDragData {
        fn supports(format: &FORMATETC) -> bool {
            format.cfFormat == CF_HDROP.0
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
    }

    impl IDataObject_Impl for FileDragData_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> WinResult<STGMEDIUM> {
            unsafe {
                if pformatetcin.is_null() || !FileDragData::supports(&*pformatetcin) {
                    return Err(Error::from_hresult(DV_E_FORMATETC));
                }

                self.hdrop_medium()
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
                    emitted: Cell::new(false),
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

        let result = DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect).ok();

        if ole_initialized {
            OleUninitialize();
        }

        result.map(|_| ()).map_err(|e| e.to_string())
    }
}
