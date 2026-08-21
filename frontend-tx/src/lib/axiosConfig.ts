import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";
let hasForcedRedirect = false;

const shouldResetSession = (error: any) => {
    const status = error?.response?.status;

    if (status === 401) return true;
    if (status === 403) return true;

    return false;
};

const clearSessionAndRedirect = () => {
    const token = localStorage.getItem("token");
    if (!token) {
        return;
    }

    localStorage.removeItem("token");
    localStorage.removeItem("email");
    localStorage.removeItem("role");
    localStorage.removeItem("userName");
    localStorage.removeItem("phone");
    localStorage.removeItem("taxiNumber");

    if (!hasForcedRedirect) {
        hasForcedRedirect = true;
        window.location.href = "/login";
    }
};

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
        if (shouldResetSession(error)) {
            console.error("❌ Token inválido o expirado");
            clearSessionAndRedirect();
        }
        return Promise.reject(error);
    }
);

export default axiosInstance;
