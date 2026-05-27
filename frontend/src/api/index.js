import http from './http.js';

export const authApi = {
  loginUrl: () => http.get('/auth/cas/login-url'),
  login: (empNo, password) => http.post('/auth/login', { empNo, password }),
  me: () => http.get('/auth/me'),
  logout: () => http.post('/auth/logout'),
};

export const userApi = {
  getProfile: (id) => http.get(`/users/${id}`),
  updateMe: (data) => http.put('/users/me', data),
  myPosts: (params) => http.get('/users/me/posts', { params }),
  myFavorites: () => http.get('/users/me/favorites'),
  myComments: () => http.get('/users/me/comments'),
};

export const categoryApi = {
  tree: () => http.get('/categories'),
  create: (data) => http.post('/admin/categories', data),
  update: (id, data) => http.put(`/admin/categories/${id}`, data),
  remove: (id) => http.delete(`/admin/categories/${id}`),
};

export const postApi = {
  list: (params) => http.get('/posts', { params }),
  detail: (id) => http.get(`/posts/${id}`),
  create: (data) => http.post('/posts', data),
  update: (id, data) => http.put(`/posts/${id}`, data),
  remove: (id) => http.delete(`/posts/${id}`),
  like: (id) => http.post(`/posts/${id}/like`),
  favorite: (id) => http.post(`/posts/${id}/favorite`),
  recommend: () => http.get('/posts/recommend'),
  explain: (id) => http.get(`/posts/${id}/explain`),
  pin: (id, level) => http.post(`/admin/posts/${id}/pin`, { level }),
  feature: (id) => http.post(`/admin/posts/${id}/feature`),
  block: (id) => http.post(`/admin/posts/${id}/block`),
};

export const commentApi = {
  list: (postId) => http.get(`/posts/${postId}/comments`),
  create: (postId, data) => http.post(`/posts/${postId}/comments`, data),
  remove: (id) => http.delete(`/comments/${id}`),
  like: (id) => http.post(`/comments/${id}/like`),
};

export const notifApi = {
  list: (params) => http.get('/notifications', { params }),
  markRead: (ids) => http.post('/notifications/read', { ids }),
};

export const reportApi = {
  create: (data) => http.post('/reports', data),
  list: (params) => http.get('/admin/reports', { params }),
  handle: (id, data) => http.post(`/admin/reports/${id}/handle`, data),
};

export const adminApi = {
  stats: () => http.get('/admin/stats'),
  aiStats: () => http.get('/admin/ai-stats'),
  users: (params) => http.get('/admin/users', { params }),
  updateUserRole: (id, data) => http.put(`/admin/users/${id}/role`, data),
  words: () => http.get('/admin/sensitive-words'),
  addWord: (data) => http.post('/admin/sensitive-words', data),
  deleteWord: (id) => http.delete(`/admin/sensitive-words/${id}`),
  audits: (params) => http.get('/admin/audit-logs', { params }),
  settings: () => http.get('/admin/settings'),
  updateSetting: (key, value) => http.put('/admin/settings', { key, value }),
  testAi: (data) => http.post('/admin/ai/test', data || {}),
};

export const uploadApi = {
  url: '/api/upload',
};

export const aiApi = {
  ask: (question, topN = 5) => http.post('/ai/ask', { question, topN }),
  // 流式：返回原生 fetch Response 的 ReadableStream，由调用方处理 SSE
  askStream: (question, topN = 5, token) =>
    fetch('/api/ai/ask/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question, topN }),
    }),
  assist: (kind, payload) => http.post('/ai/assist', { kind, ...payload }),
};
