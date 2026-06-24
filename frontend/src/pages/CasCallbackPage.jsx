import { useEffect } from 'react';
import { Result, Spin, App } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authApi } from '../api';
import { useAuthStore } from '../store/auth.js';

export default function CasCallbackPage() {
  const [params] = useSearchParams();
  const { setAuth } = useAuthStore();
  const { message } = App.useApp();
  const nav = useNavigate();

  useEffect(() => {
    const ticket = params.get('ticket');
    if (!ticket) {
      message.error('CAS 回调缺少 ticket');
      nav('/login', { replace: true });
      return;
    }

    const service = `${window.location.origin}/login/cas-callback`;
    authApi.casCallback(ticket, service)
      .then(({ token, user }) => {
        setAuth(token, user);
        message.success(`欢迎回来，${user.nickname || user.name}`);
        nav('/', { replace: true });
      })
      .catch(() => {
        nav('/login', { replace: true });
      });
  }, [params, setAuth, message, nav]);

  return (
    <Result
      icon={<Spin size="large" />}
      title="正在完成 CAS 登录"
      subTitle="请稍候"
    />
  );
}
