/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL. Unset = client-only; "" = same-origin; or a full URL. */
  readonly VITE_BACKEND_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
