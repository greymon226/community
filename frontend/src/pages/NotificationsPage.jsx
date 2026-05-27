import { useEffect, useState } from 'react';
import { Card, List, Tag, Button, Empty, App, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { notifApi } from '../api';

const TYPE_LABEL = {
  commented: { color: 'blue', text: '评论' },
  replied: { color: 'cyan', text: '回复' },
  liked: { color: 'pink', text: '点赞' },
  featured: { color: 'magenta', text: '加精' },
  pinned: { color: 'orange', text: '置顶' },
  system: { color: 'default', text: '系统' },
};

export default function NotificationsPage() {
  const [data, setData] = useState({ items: [], total: 0, unreadCount: 0 });
  const nav = useNavigate();
  const { message } = App.useApp();

  const load = () => notifApi.list({ pageSize: 50 }).then(setData);
  useEffect(() => { load(); }, []);

  const markAll = async () => {
    await notifApi.markRead();
    message.success('已全部标记为已读');
    load();
  };
  const markOne = async (n) => {
    if (!n.read) await notifApi.markRead([n.id]);
    const payload = JSON.parse(n.payload || '{}');
    if (payload.postId) nav(`/post/${payload.postId}`);
  };

  return (
    <Card
      title={`消息中心 (未读 ${data.unreadCount})`}
      extra={<Button onClick={markAll}>一键已读</Button>}
    >
      {data.items.length === 0 ? (
        <Empty description="暂无通知" />
      ) : (
        <List
          dataSource={data.items}
          renderItem={(n) => {
            const t = TYPE_LABEL[n.type] || TYPE_LABEL.system;
            return (
              <List.Item
                style={{ background: n.read ? 'transparent' : '#e6f4ff', cursor: 'pointer' }}
                onClick={() => markOne(n)}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag color={t.color}>{t.text}</Tag>
                      <span>{n.title}</span>
                      {!n.read && <Tag color="red">未读</Tag>}
                    </Space>
                  }
                  description={
                    <>
                      <div>{n.content}</div>
                      <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                        {dayjs(n.createdAt).format('YYYY-MM-DD HH:mm')}
                      </span>
                    </>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </Card>
  );
}
