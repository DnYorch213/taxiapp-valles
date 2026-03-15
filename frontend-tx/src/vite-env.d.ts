/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_URL: string;
    // Agrega aquí otras variables si las tienes
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}