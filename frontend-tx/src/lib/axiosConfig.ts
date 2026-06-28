import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Crear instancia de axios con URL base
export const axiosInstance = axios.create({
    baseURL: API_URL,
    timeout: 10000,
    headers: {
        'Content-Type': 'application/json',
    },
});

// 🔐 Interceptor: Agregar token JWT automáticamente a cada petición
axiosInstance.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem("token");
        if (token) {
            config.headers = config.headers || {};
            (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// 🔐 Interceptor: Manejar errores de autenticación
axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
        // Si recibimos 403, significa que el token es inválido o expiró
        if (error.response?.status === 401 || error.response?.status === 403) {
            console.error("❌ Token inválido o expirado");
            // Limpiar localStorage
            localStorage.removeItem("token");
            localStorage.removeItem("email");
            localStorage.removeItem("role");
            // Redireccionar al login (opcional, según tu implementación)
            window.location.href = "/login";
        }
        return Promise.reject(error);
    }
);

export default axiosInstance;
