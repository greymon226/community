import { useEffect, useRef } from 'react';
import { Result, Spin, App } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api';
import { useAuthStore } from '../store/auth.js';

export default function GithubCallbackPage() {
  const [params] = useSearchParams();
  const { setAuth } = useAuthStore();
  const { message } = App.useApp();
  const nav = useNavigate();
  // 防止 React StrictMode 双重调用
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;

    const code = params.get('code');
    const state = params.get('state');
    const savedState = sessionStorage.getItem('github_oauth_state');

    // 阅后即焚，防止重放攻击
    sessionStorage.removeItem('github_oauth_state');

    if (!code) {
      message.error('GitHub 回调缺少 code 参数');
      nav('/login', { replace: true });
      return;
    }

    if (!state || state !== savedState) {
      message.error('安全验证失败 (CSRF State Mismatch)，请重新登录');
      nav('/login', { replace: true });
      return;
    }

    authApi.githubCallback(code)
      .then(({ token, user }) => {
        setAuth(token, user);
        message.success(`欢迎，${user.nickname || user.name}`);
        nav('/', { replace: true });
      })
      .catch((err) => {
        message.error(err?.message || 'GitHub 登录失败，请重试');
        nav('/login', { replace: true });
      });
  }, [params, setAuth, message, nav]);

  return (
    <Result
      icon={<Spin size="large" />}
      title="正在完成 GitHub 登录"
      subTitle="请稍候，正在验证您的 GitHub 身份…"
    />
  );
}
