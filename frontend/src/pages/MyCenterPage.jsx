import { useEffect, useState } from 'react';
import { Tabs, List, Empty, Card, Tag, Button, Space, App } from 'antd';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import { userApi, postApi } from '../api';
import { useAuthStore } from '../store/auth.js';

export default function MyCenterPage() {
  const { user, token } = useAuthStore();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [posts, setPosts] = useState({ items: [], total: 0 });
  const [favs, setFavs] = useState([]);
  const [comments, setComments] = useState([]);
  const [activeKey, setActiveKey] = useState('posts');

  useEffect(() => {
    if (!token) return nav('/login');
    if (activeKey === 'posts') userApi.myPosts({ status: 'all' }).then(setPosts);
    if (activeKey === 'favs') userApi.myFavorites().then(setFavs);
    if (activeKey === 'comments') userApi.myComments().then(setComments);
  }, [activeKey]);

  if (!user) return null;

  const items = [
    {
      key: 'posts',
      label: `我的帖子 (${posts.total ?? '-'})`,
      children: posts.items?.length ? (
        <List
          dataSource={posts.items}
          renderItem={(p) => (
            <List.Item
              actions={[
                <Button type="link" onClick={() => nav(`/post/${p.id}`)}>查看</Button>,
                <Button type="link" onClick={() => nav(`/post/edit/${p.id}`)}>编辑</Button>,
                <Button type="link" danger onClick={async () => {
                  await postApi.remove(p.id);
                  message.success('已删除');
                  userApi.myPosts({ status: 'all' }).then(setPosts);
                }}>删除</Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    {p.title}
                    {p.status === 'draft' && <Tag>草稿</Tag>}
                    {p.status === 'blocked' && <Tag color="red">已屏蔽</Tag>}
                    {p.status === 'deleted' && <Tag color="default">已删除</Tag>}
                  </Space>
                }
                description={`${dayjs(p.createdAt).format('YYYY-MM-DD HH:mm')} · 👍 ${p.likeCount} · 💬 ${p.commentCount}`}
              />
            </List.Item>
          )}
        />
      ) : <Empty />,
    },
    {
      key: 'favs',
      label: '我的收藏',
      children: favs.length ? (
        <List
          dataSource={favs}
          renderItem={(p) => (
            <List.Item actions={[<Button type="link" onClick={() => nav(`/post/${p.id}`)}>查看</Button>]}>
              <List.Item.Meta
                title={p.title}
                description={`${p.author?.nickname || p.author?.name} · ${dayjs(p.createdAt).format('YYYY-MM-DD')}`}
              />
            </List.Item>
          )}
        />
      ) : <Empty />,
    },
    {
      key: 'comments',
      label: '我的评论',
      children: comments.length ? (
        <List
          dataSource={comments}
          renderItem={(c) => (
            <List.Item actions={[<Button type="link" onClick={() => nav(`/post/${c.postId}`)}>查看帖子</Button>]}>
              <List.Item.Meta
                title={c.post?.title}
                description={
                  <div>
                    <div dangerouslySetInnerHTML={{ __html: c.content }} />
                    <span style={{ color: '#8c8c8c', fontSize: 12 }}>
                      {dayjs(c.createdAt).format('YYYY-MM-DD HH:mm')}
                    </span>
                  </div>
                }
              />
            </List.Item>
          )}
        />
      ) : <Empty />,
    },
  ];

  return (
    <Card title="个人中心" extra={<Button onClick={() => nav(`/profile/${user.id}?edit=1`)}>编辑资料</Button>}>
      <Tabs activeKey={activeKey} onChange={setActiveKey} items={items} />
    </Card>
  );
}
