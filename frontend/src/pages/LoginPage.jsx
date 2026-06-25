import { useEffect, useState } from 'react';
import { Card, Form, Input, Button, Alert, Typography, App, Divider } from 'antd';
import { GithubOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { authApi } from '../api';
import { useAuthStore } from '../store/auth.js';

const { Title, Paragraph } = Typography;

export default function LoginPage() {
  const [casInfo, setCasInfo] = useState({ mock: true, url: '' });
  const [githubUrl, setGithubUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const { message } = App.useApp();
  const nav = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    authApi.loginUrl(`${window.location.origin}/login/cas-callback`).then(setCasInfo).catch(() => { });
    // 生成随机 state 并保存到 sessionStorage
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('github_oauth_state', state);
    authApi.githubLoginUrl(state).then(({ enabled, url }) => {
      if (enabled && url) setGithubUrl(url);
      else sessionStorage.removeItem('github_oauth_state');
    }).catch(() => { });
  }, []);

  const onFinish = async (values) => {
    setLoading(true);
    try {
      const { token, user } = await authApi.login(values.empNo, values.password);
      setAuth(token, user);
      message.success(`欢迎回来，${user.nickname || user.name}`);
      const next = new URLSearchParams(loc.search).get('next') || '/';
      nav(next);
    } finally {
      setLoading(false);
    }
  };

  const goCas = () => {
    if (casInfo.url) window.location.href = casInfo.url;
  };

  const casAvailable = !casInfo.mock && !!casInfo.url;
  const thirdPartyCount = (casAvailable ? 1 : 0) + (githubUrl ? 1 : 0);
  const thirdPartyGridStyle = {
    display: 'grid',
    gridTemplateColumns: thirdPartyCount > 1 ? '1fr 1fr' : '1fr',
    gap: 12,
    marginBottom: casInfo.mock ? 0 : 16,
  };

  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 60 }}>
      <Card style={{ width: 420 }}>
        <Title level={3} style={{ textAlign: 'center', marginBottom: 8 }}>登录</Title>
        <Paragraph type="secondary" style={{ textAlign: 'center' }}>
          {casInfo.mock ? '使用工号/密码登录，也可选择第三方登录' : '使用工号/密码登录，或选择第三方登录'}
        </Paragraph>

        {(casAvailable || githubUrl) && <Divider plain>账号密码</Divider>}

        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item label="工号" name="empNo" rules={[{ required: true, message: '请输入工号' }]}>
            <Input placeholder="例如: admin" />
          </Form.Item>
          <Form.Item label="密码" name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="例如: admin123" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>登录</Button>
        </Form>

        <Alert
          showIcon
          style={{ marginTop: 16 }}
          type="info"
          message="演示账号"
          description={(
            <div>
              <div>admin / admin123 （超级管理员）</div>
              <div>mod001 / mod123 （版主）</div>
              <div>user001 / user123 （普通用户）</div>
            </div>
          )}
        />

        {(casAvailable || githubUrl) && (
          <>
            <Divider plain>第三方登录</Divider>
            <div style={thirdPartyGridStyle}>
              {casAvailable && (
                <Button
                  id="btn-cas-login"
                  block
                  type="primary"
                  size="large"
                  icon={<SafetyCertificateOutlined />}
                  onClick={goCas}
                >
                  CAS 登录
                </Button>
              )}
              {githubUrl && (
                <Button
                  id="btn-github-login"
                  block
                  size="large"
                  icon={<GithubOutlined />}
                  onClick={() => { window.location.href = githubUrl; }}
                  style={{
                    background: '#24292e',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 6,
                    fontWeight: 500,
                  }}
                >
                  GitHub 登录
                </Button>
              )}
            </div>
          </>
        )}

      </Card>
    </div>
  );
}
