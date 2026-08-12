import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";
let hasForcedRedirect = false;

const shouldResetSession = (error: any) => {
    const status = error?.response?.status;
    const message = String(error?.response?.data?.message || "").toLowerCase();

    if (status === 401) return true;
    if (status !== 403) return false;

    return message.includes("token expirado") ||
        message.includes("token inv?lido") ||
        message.includes("token no proporcionado");
};

const clearSessionAndRedirect = () => {
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

export const axiosInstance = axios.create({
    baseURL: API_URL,
    timeout: 10000,
    withCredentials: true,
    headers: {
        'Content-Type': 'application/json',
    },
});

axiosInstance.interceptors.request.use(
    (config) => {
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

axiosInstance.interceptors.response.use(
    (response) => response,
    (error) => {
        if (shouldResetSession(error)) {
            console.error("? Token inv?lido o expirado");
            clearSessionAndRedirect();
        }
        return Promise.reject(error);
    }
);

export default axiosInstance;
