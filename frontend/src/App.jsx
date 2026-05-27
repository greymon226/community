import { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu, Avatar, Dropdown, Badge, Input, Button } from 'antd';
import { BellOutlined, UserOutlined, EditOutlined, LogoutOutlined, SettingOutlined } from '@ant-design/icons';
import { useAuthStore } from './store/auth.js';
import { authApi, notifApi } from './api';

import HomePage from './pages/HomePage.jsx';
import PostDetailPage from './pages/PostDetailPage.jsx';
import PostEditPage from './pages/PostEditPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import MyCenterPage from './pages/MyCenterPage.jsx';
import NotificationsPage from './pages/NotificationsPage.jsx';
import AdminPage from './pages/AdminPage.jsx';
import { useState } from 'react';

const { Header, Content } = Layout;

export default function App() {
  const { token, user, setUser, logout } = useAuthStore();
  const nav = useNavigate();
  const loc = useLocation();
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (token && !user) {
      authApi.me().then(setUser).catch(() => logout());
    }
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let timer;
    const fetchUnread = () =>
      notifApi.list({ unreadOnly: 1, page: 1, pageSize: 1 })
        .then((r) => setUnread(r.unreadCount || 0))
        .catch(() => {});
    fetchUnread();
    timer = setInterval(fetchUnread, 30000);
    return () => clearInterval(timer);
  }, [token]);

  const handleSearch = (v) => {
    if (v) nav(`/?keyword=${encodeURIComponent(v)}`);
  };

  const userMenu = {
    items: [
      { key: 'me', icon: <UserOutlined />, label: '个人中心' },
      { key: 'edit', icon: <EditOutlined />, label: '资料设置' },
      ...(user?.role === 'admin' || user?.role === 'moderator'
        ? [{ key: 'admin', icon: <SettingOutlined />, label: '管理后台' }]
        : []),
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
    ],
    onClick: ({ key }) => {
      if (key === 'me') nav('/me');
      if (key === 'edit') nav(`/profile/${user.id}?edit=1`);
      if (key === 'admin') nav('/admin');
      if (key === 'logout') {
        authApi.logout().finally(() => {
          logout();
          nav('/login');
        });
      }
    },
  };

  const selectedKey = loc.pathname.startsWith('/admin')
    ? 'admin'
    : loc.pathname.startsWith('/me')
    ? 'me'
    : 'home';

  return (
    <Layout className="app-layout">
      <Header className="app-header">
        <div className="logo" onClick={() => nav('/')}>🚀 技术交流社区</div>
        <Menu
          mode="horizontal"
          className="nav hide-mobile"
          selectedKeys={[selectedKey]}
          items={[
            { key: 'home', label: '首页', onClick: () => nav('/') },
            ...(token ? [{ key: 'me', label: '我的', onClick: () => nav('/me') }] : []),
            ...(user?.role === 'admin' || user?.role === 'moderator'
              ? [{ key: 'admin', label: '管理', onClick: () => nav('/admin') }]
              : []),
          ]}
          style={{ borderBottom: 'none' }}
        />
        <Input.Search
          placeholder="搜索标题/内容/作者"
          allowClear
          onSearch={handleSearch}
          style={{ width: 280 }}
          className="hide-mobile"
        />
        {token && (
          <Button type="primary" onClick={() => nav('/post/new')}>
            发帖
          </Button>
        )}
        {token ? (
          <>
            <Badge count={unread} size="small">
              <BellOutlined
                style={{ fontSize: 18, cursor: 'pointer' }}
                onClick={() => nav('/notifications')}
              />
            </Badge>
            <Dropdown menu={userMenu} placement="bottomRight">
              <Avatar
                src={user?.avatar}
                icon={<UserOutlined />}
                style={{ cursor: 'pointer' }}
              />
            </Dropdown>
          </>
        ) : (
          <Button onClick={() => nav('/login')}>登录</Button>
        )}
      </Header>
      <Content className="app-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/post/new" element={<PostEditPage />} />
          <Route path="/post/edit/:id" element={<PostEditPage />} />
          <Route path="/post/:id" element={<PostDetailPage />} />
          <Route path="/profile/:id" element={<ProfilePage />} />
          <Route path="/me" element={<MyCenterPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Content>
    </Layout>
  );
}
