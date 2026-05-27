import axios from 'axios';
import { message } from 'antd';
import { useAuthStore } from '../store/auth.js';

const http = axios.create({ baseURL: '/api', timeout: 15000 });

http.interceptors.request.use((cfg) => {
  const token = useAuthStore.getState().token;
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

http.interceptors.response.use(
  (resp) => {
    const { data } = resp;
    if (data && data.code === 0) return data.data;
    message.error(data?.message || '请求失败');
    return Promise.reject(new Error(data?.message || 'error'));
  },
  (err) => {
    const status = err.response?.status;
    if (status === 401) {
      useAuthStore.getState().logout();
      message.error('登录已失效，请重新登录');
      if (location.pathname !== '/login') location.href = '/login';
    } else {
      message.error(err.response?.data?.message || err.message || '网络异常');
    }
    return Promise.reject(err);
  }
);

export default http;
